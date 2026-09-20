package com.mengzhihua.agent;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Locale;
import org.springframework.stereotype.Component;

@Component
public class AgentBinary {
  public Path resolve() throws IOException {
    String env = firstNonBlank(System.getenv("AGENT_BIN"), System.getProperty("agent.bin"));
    if (env != null) {
      Path given = Path.of(env).toAbsolutePath();
      if (!Files.isRegularFile(given)) {
        throw new IOException("AGENT_BIN does not exist: " + given);
      }
      return given;
    }
    Path extracted = extractBundled();
    if (extracted != null) return extracted;
    Path found = which("agent");
    if (found != null) return found;
    throw new IOException(
        "agent binary not found. Set AGENT_BIN, install a native agent on PATH, or use a release JAR that embeds the binary.");
  }

  private Path extractBundled() throws IOException {
    String resource = bundledResourceName();
    try (InputStream in = AgentBinary.class.getResourceAsStream("/native/" + resource)) {
      if (in == null) return null;
      Path dest = Path.of(System.getProperty("user.home"), ".agent", "runtime", resource);
      Files.createDirectories(dest.getParent());
      Files.copy(in, dest, StandardCopyOption.REPLACE_EXISTING);
      dest.toFile().setExecutable(true, false);
      return dest;
    }
  }

  static String bundledResourceName() {
    String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    String arch = System.getProperty("os.arch", "").toLowerCase(Locale.ROOT);
    boolean arm = arch.contains("aarch") || arch.contains("arm64");
    if (os.contains("win")) return arm ? "agent-win-arm64.exe" : "agent-win-x64.exe";
    if (os.contains("mac")) return arm ? "agent-darwin-arm64" : "agent-darwin-x64";
    return arm ? "agent-linux-arm64" : "agent-linux-x64";
  }

  private static Path which(String name) {
    String path = System.getenv("PATH");
    if (path == null) return null;
    boolean win = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    String[] names = win ? new String[] {name + ".exe", name + ".cmd", name} : new String[] {name};
    for (String dir : path.split(win ? ";" : ":")) {
      if (dir.isBlank()) continue;
      for (String candidate : names) {
        Path file = Path.of(dir, candidate);
        if (Files.isRegularFile(file)) return file;
      }
    }
    return null;
  }

  private static String firstNonBlank(String... values) {
    for (String value : values) {
      if (value != null && !value.isBlank()) return value;
    }
    return null;
  }
}
