package com.mengzhihua.agent;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class WebUiController {
  @GetMapping(value = { "/", "/ui" }, produces = MediaType.TEXT_HTML_VALUE)
  public String ui() throws IOException {
    try (InputStream in = WebUiController.class.getResourceAsStream("/static/index.html")) {
      if (in == null) {
        return "<!doctype html><title>agent</title><p>web console missing. Use <code>agent serve</code>.</p>";
      }
      return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }
  }
}
