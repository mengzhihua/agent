package com.mengzhihua.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class AgentApiController {
  private final AgentCli cli;
  private final ObjectMapper mapper;

  public AgentApiController(AgentCli cli, ObjectMapper mapper) {
    this.cli = cli;
    this.mapper = mapper;
  }

  @GetMapping({"/", "/v1/health"})
  public Map<String, Object> health() throws Exception {
    String version = cli.run(List.of("--version"), 30).trim();
    return Map.of("status", "UP", "version", version, "runtime", "spring-boot");
  }

  @PostMapping("/v1/prompt")
  public JsonNode prompt(@RequestBody PromptRequest body) throws Exception {
    if (body == null || body.prompt == null || body.prompt.isBlank()) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "prompt is required");
    }
    List<String> args = new ArrayList<>();
    args.add("--print");
    args.add("--output-format");
    args.add("json");
    args.add("-y");
    if (body.workspace != null && !body.workspace.isBlank()) {
      args.add("-w");
      args.add(body.workspace);
    }
    if (body.sessionId != null && !body.sessionId.isBlank()) {
      args.add("--resume");
      args.add(body.sessionId);
    }
    if (body.files != null) {
      for (String file : body.files) {
        args.add("--file");
        args.add(file);
      }
    }
    args.add(body.prompt);
    String raw = cli.run(args, 600);
    return mapper.readTree(lastJsonLine(raw));
  }

  @GetMapping("/v1/sessions")
  public JsonNode sessions() throws Exception {
    String raw = cli.run(List.of("session", "list", "--output-format", "json"), 30);
    return mapper.readTree(lastJsonLine(raw));
  }

  @GetMapping("/v1/sessions/{id}")
  public JsonNode show(@PathVariable("id") String id) throws Exception {
    try {
      String raw = cli.run(List.of("session", "show", id, "--output-format", "json"), 30);
      return mapper.readTree(lastJsonLine(raw));
    } catch (Exception ex) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, ex.getMessage());
    }
  }

  @DeleteMapping("/v1/sessions/{id}")
  public JsonNode delete(@PathVariable("id") String id) throws Exception {
    String raw = cli.run(List.of("session", "delete", id, "--output-format", "json"), 30);
    return mapper.readTree(lastJsonLine(raw));
  }

  @PostMapping("/v1/sessions")
  public ResponseEntity<ObjectNode> create() {
    ObjectNode node = mapper.createObjectNode();
    node.put("id", "");
    node.put("hint", "POST /v1/prompt without sessionId to create one");
    return ResponseEntity.status(HttpStatus.CREATED).body(node);
  }

  static String lastJsonLine(String raw) {
    String[] lines = raw.split("\n");
    for (int i = lines.length - 1; i >= 0; i--) {
      String line = lines[i].trim();
      if (line.startsWith("{") || line.startsWith("[")) return line;
    }
    return raw;
  }

  public static class PromptRequest {
    public String prompt;
    public String sessionId;
    public String workspace;
    public List<String> files;
  }
}
