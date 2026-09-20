package com.mengzhihua.agent;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class TokenFilter extends OncePerRequestFilter {
  @Value("${agent.token:}")
  private String token;

  @Override
  protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
      throws ServletException, IOException {
    String path = request.getRequestURI();
    boolean open =
        path.equals("/")
            || path.equals("/ui")
            || path.equals("/v1")
            || path.equals("/v1/health")
            || path.startsWith("/actuator/health")
            || "OPTIONS".equalsIgnoreCase(request.getMethod());
    String expected = firstNonBlank(System.getenv("AGENT_SERVE_TOKEN"), token);
    if (expected == null || expected.isBlank() || open) {
      filterChain.doFilter(request, response);
      return;
    }
    String header = request.getHeader("Authorization");
    String alt = request.getHeader("X-Agent-Token");
    boolean ok = ("Bearer " + expected).equals(header) || expected.equals(alt);
    if (!ok) {
      response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
      response.setContentType("application/json");
      response.getWriter().write("{\"error\":\"unauthorized\"}");
      return;
    }
    filterChain.doFilter(request, response);
  }

  private static String firstNonBlank(String... values) {
    for (String value : values) {
      if (value != null && !value.isBlank()) return value;
    }
    return null;
  }
}
