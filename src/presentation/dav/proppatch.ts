import { SaxesParser } from "saxes";
import { AppleColor } from "../../domain/caldav";
import { escapeXml, InvalidDavXmlError, missingPropNameXml, multistatus, qualifiedPropKey, type RequestedPropName } from "./xml";

type Status = "200 OK" | "403 Forbidden" | "409 Conflict" | "424 Failed Dependency";
interface Operation extends RequestedPropName {
	kind: "set" | "remove";
	value: string;
	hasChildren: boolean;
}
interface Metadata {
	displayName?: string;
	color?: string;
	order?: number;
}
export interface PropertyUpdatePlan {
	/** undefined means that no application/usecase write may be attempted. */
	metadata: Metadata | undefined;
	results: readonly (RequestedPropName & { status: Status })[];
}

/**
 * PROPPATCH alone needs an ordered instruction list. Reusing MKCOL's permissive
 * extractor drops unsupported names and loses set/remove order (todo0007).
 * Finish parsing before planning any write, so malformed trailing XML cannot
 * apply a valid prefix. Namespace scopes and entity decoding belong to saxes.
 */
function parseOperations(body: string): Operation[] {
	const parser = new SaxesParser({ xmlns: true });
	const operations: Operation[] = [];
	let depth = 0;
	let kind: Operation["kind"] = "set";
	let propCount = 0;
	let propertyCount = 0;
	let current: Operation | undefined;
	const invalid = () => { throw new InvalidDavXmlError("Malformed DAV propertyupdate"); };
	parser.on("doctype", invalid);
	parser.on("error", invalid);
	parser.on("opentag", (tag) => {
		depth++;
		if (depth === 1) {
			if (tag.uri !== "DAV:" || tag.local !== "propertyupdate") invalid();
		} else if (depth === 2) {
			if (tag.uri !== "DAV:" || (tag.local !== "set" && tag.local !== "remove")) invalid();
			kind = tag.local as Operation["kind"];
			propCount = 0;
		} else if (depth === 3) {
			if (tag.uri !== "DAV:" || tag.local !== "prop" || ++propCount !== 1) invalid();
			propertyCount = 0;
		} else if (depth === 4) {
			propertyCount++;
			current = { namespace: tag.uri, localName: tag.local, kind, value: "", hasChildren: false };
		} else if (current) {
			// A nested element is a property value, never another instruction.
			current.hasChildren = true;
		}
	});
	const text = (value: string) => {
		if (depth >= 4 && current) current.value += value;
		else if (value.trim()) invalid();
	};
	parser.on("text", text);
	parser.on("cdata", text);
	parser.on("closetag", () => {
		if (depth === 4 && current) {
			if (current.kind === "remove" && (current.hasChildren || current.value.trim())) invalid();
			operations.push(current);
			current = undefined;
		}
		if (depth === 3 && propertyCount === 0) invalid();
		if (depth === 2 && propCount !== 1) invalid();
		depth--;
	});
	parser.write(body).close();
	if (operations.length === 0) invalid();
	return operations;
}

/**
 * RFC 4918 §9.2: all instructions or none. Compute the final metadata in memory
 * in document order, then let the existing UC perform its single save. No new
 * dead-property storage or metadata deletion is introduced into shared MCP/UC.
 * Unsupported removals therefore fail explicitly instead of being ignored.
 */
export function planPropertyUpdate(body: string): PropertyUpdatePlan {
	const operations = parseOperations(body);
	const metadata: Metadata = {};
	const results = new Map<string, RequestedPropName & { status: Status }>();
	let failed = false;
	for (const op of operations) {
		const key = qualifiedPropKey(op.namespace, op.localName);
		const field = op.namespace === "DAV:" && op.localName === "displayname" ? "displayName"
			: op.namespace === "http://apple.com/ns/ical/" && op.localName === "calendar-color" ? "color"
			: op.namespace === "http://apple.com/ns/ical/" && op.localName === "calendar-order" ? "order" : undefined;
		let status: Status = "200 OK";
		if (!field || op.kind === "remove") status = "403 Forbidden";
		else if (op.hasChildren) status = "409 Conflict";
		else {
			// Keep the existing trimming and Apple color validation. Empty values
			// must no longer disappear as a silent no-op in a multi-property write.
			const value = op.value.trim();
			if (!value) status = "409 Conflict";
			else if (field === "color") {
				try { metadata.color = AppleColor.parse(value).toString(); }
				catch { status = "409 Conflict"; }
			} else if (field === "order") {
				const order = Number(value);
				if (!Number.isFinite(order)) status = "409 Conflict";
				else metadata.order = order;
			} else metadata.displayName = value;
		}
		if (status !== "200 OK") failed = true;
		// One propstat result per QName. A later valid set cannot erase an
		// earlier failure: atomicity applies to instructions, not just values.
		const previous = results.get(key);
		if (!previous || previous.status === "200 OK") results.set(key, { namespace: op.namespace, localName: op.localName, status });
	}
	return {
		metadata: failed ? undefined : metadata,
		results: [...results.values()].map((result) => ({ ...result,
			status: failed && result.status === "200 OK" ? "424 Failed Dependency" : result.status })),
	};
}

/** All response names come from parser-validated QNames, including unknowns. */
export function propertyUpdateResponse(href: string, plan: PropertyUpdatePlan): string {
	const groups = new Map<Status, string[]>();
	for (const result of plan.results) {
		// Reuse the read codec's QName serializer so DAV/Apple prefixes stay
		// compatible and unknown namespace URIs are escaped consistently.
		const name = missingPropNameXml([result]);
		const group = groups.get(result.status) ?? [];
		group.push(name);
		groups.set(result.status, group);
	}
	const props = [...groups].map(([status, names]) =>
		`<d:propstat><d:prop>${names.join("")}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>`).join("");
	return multistatus(`<d:response><d:href>${escapeXml(href)}</d:href>${props}</d:response>`);
}
