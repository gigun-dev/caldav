// v0.2.1 の一時 checkout/internal/app にコピーして実行する境界検証。
// caldav の本番 code と bridge 稼働 process は変更しない。schema は tools/list 由来。
package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
)

type caldavTool struct {
	Name   string         `json:"name"`
	Schema map[string]any `json:"inputSchema"`
}

func caldavSchemas(t *testing.T) map[string][]caldavTool {
	t.Helper()
	data, err := os.ReadFile(os.Getenv("CALDAV_SCHEMA_FILE"))
	if err != nil {
		t.Fatal(err)
	}
	var schemas map[string][]caldavTool
	if err := json.Unmarshal(data, &schemas); err != nil {
		t.Fatal(err)
	}
	return schemas
}

func caldavRequest(schema caldavTool, mode string) (string, map[string]any) {
	function := map[string]any{"name": schema.Name, "parameters": schema.Schema,
		"description": "繰り返しを展開して指定範囲の予定を取得する。"}
	if mode != "chat-omitted" {
		function["strict"] = false
	}
	prompt := "今日の予定を取得してください。タイムゾーンは Asia/Tokyo です。変更はしません。"
	if mode == "responses-false" {
		function["type"] = "function"
		return "/v1/responses", map[string]any{"model": "gpt-5.6-luna", "input": prompt,
			"tools": []any{function}, "tool_choice": "required", "store": false}
	}
	return "/v1/chat/completions", map[string]any{"model": "gpt-5.6-luna",
		"messages": []any{map[string]any{"role": "user", "content": prompt}},
		"tools":    []any{map[string]any{"type": "function", "function": function}}, "tool_choice": "required"}
}

func TestCaldavRangeUpstreamHTTP(t *testing.T) {
	for origin, tools := range caldavSchemas(t) {
		for _, tool := range tools {
			for _, mode := range []string{"chat-omitted", "chat-false", "responses-false"} {
				t.Run(origin+"/"+tool.Name+"/"+mode, func(t *testing.T) {
					var captured map[string]any
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.URL.Path != "/responses" {
							t.Errorf("unexpected path %s", r.URL.Path)
						}
						if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
							t.Error(err)
						}
						w.Header().Set("Content-Type", "text/event-stream")
						io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"fixture\",\"status\":\"completed\",\"output\":[]}}\n\n")
					}))
					defer upstream.Close()
					cfg := defaultConfig()
					cfg.BackendURL = upstream.URL
					cfg.AuthJSON = writeTestAuth(t, authDocument("synthetic-access", nil))
					s := &server{cfg: cfg, backend: newBackend(cfg), responses: newResponseStore(10), chats: newChatStore(10)}
					path, payload := caldavRequest(tool, mode)
					data, _ := json.Marshal(payload)
					req := httptest.NewRequest("POST", path, bytes.NewReader(data))
					req.Header.Set("Content-Type", "application/json")
					res := httptest.NewRecorder()
					s.ServeHTTP(res, req)
					if res.Code != 200 {
						t.Fatalf("HTTP status %d", res.Code)
					}
					actual := mapAny(sliceAny(captured["tools"])[0])
					if !reflect.DeepEqual(actual["parameters"], tool.Schema) {
						t.Fatal("parameters changed on upstream HTTP wire")
					}
					strict, present := actual["strict"]
					if mode == "chat-omitted" && present {
						t.Fatal("strict injected")
					}
					if mode != "chat-omitted" && (!present || strict != false) {
						t.Fatal("strict:false changed")
					}
					t.Logf("schema identical; strict_present=%t", present)
				})
			}
		}
	}
}

// 任意の live probe。出力は合成promptが返した引数だけで、実カレンダーは読まない。
// 非決定的なモデルの1試行から原因を断定しないため、結果を記録する観測として扱う。
func TestCaldavRangeLiveModel(t *testing.T) {
	if os.Getenv("CALDAV_RANGE_LIVE") != "1" {
		t.Skip("live probe disabled")
	}
	for origin, tools := range caldavSchemas(t) {
		for _, tool := range tools {
			if tool.Name != "list-events-expanded" {
				continue
			}
			for _, mode := range []string{"chat-omitted", "chat-false"} {
				for round := 1; round <= 3; round++ {
					t.Run(fmt.Sprintf("%s/%s/%d", origin, mode, round), func(t *testing.T) {
						t.Parallel()
						cfg := defaultConfig()
						cfg.AuthJSON = os.Getenv("CALDAV_PROBE_AUTH_PATH")
						_, input := caldavRequest(tool, mode)
						response, err := newBackend(cfg).collect(context.Background(), chatToResponse(input, cfg.Model))
						if err != nil {
							t.Fatalf("live request failed: %v", err)
						}
						calls := 0
						for _, item := range sliceAny(response["output"]) {
							call := mapAny(item)
							if call["type"] == "function_call" {
								calls++
								t.Logf("MODEL_TOOL origin=%s mode=%s round=%d name=%s arguments=%s", origin, mode, round, call["name"], call["arguments"])
								if path := os.Getenv("CALDAV_PROBE_RESULTS"); path != "" {
									file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
									if err != nil {
										t.Fatal(err)
									}
									data, _ := json.Marshal(map[string]any{"origin": origin, "mode": mode, "round": round, "arguments": call["arguments"]})
									_, err = file.Write(append(data, '\n'))
									file.Close()
									if err != nil {
										t.Fatal(err)
									}
								}
							}
						}
						if calls != 1 {
							t.Fatalf("tool call count %d", calls)
						}
					})
				}
			}
		}
	}
}

func TestCaldavRangeCorrection(t *testing.T) {
	if os.Getenv("CALDAV_RANGE_LIVE") != "1" {
		t.Skip("live probe disabled")
	}
	for _, tool := range caldavSchemas(t)["local"] {
		if tool.Name != "list-events-expanded" {
			continue
		}
		for _, mode := range []string{"chat-omitted", "chat-false"} {
			t.Run(mode, func(t *testing.T) {
				t.Parallel()
				cfg := defaultConfig()
				cfg.AuthJSON = os.Getenv("CALDAV_PROBE_AUTH_PATH")
				_, request := caldavRequest(tool, mode)
				payload := chatToResponse(request, cfg.Model)
				input := sliceAny(payload["input"])
				// 元traceと同じ不正引数の直後を合成し、serverの修正エラーを返す。
				// この履歴は実端末の全履歴ではなく、修正指示を読めるかの独立した対照。
				input = append(input, map[string]any{"type": "function_call", "call_id": "fixture_call",
					"name": tool.Name, "arguments": `{"range":"today","timeZone":"Asia/Tokyo","timeMin":"","timeMax":""}`})
				result := map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": `range(相対レンジ)と timeMin/timeMax(絶対範囲)は同時に指定できません。timeMin/timeMax は空文字でも指定扱いです。range を使う場合は両キーを削除してください。例 {"range":"today","timeZone":"Asia/Tokyo"}。`}}}
				data, _ := json.Marshal(result)
				payload["input"] = append(input, map[string]any{"type": "function_call_output", "call_id": "fixture_call", "output": string(data)})
				response, err := newBackend(cfg).collect(context.Background(), payload)
				if err != nil {
					t.Fatal(err)
				}
				for _, item := range sliceAny(response["output"]) {
					call := mapAny(item)
					if call["type"] == "function_call" {
						t.Logf("CORRECTION_TOOL mode=%s arguments=%s", mode, call["arguments"])
					}
				}
			})
		}
	}
}
