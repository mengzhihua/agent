package com.mengzhihua.agent;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.springframework.stereotype.Component;

@Component
public class AgentCli {
  private final AgentBinary binary;

  public AgentCli(AgentBinary binary) {
    this.binary = binary;
  }

  public String run(List<String> args, long timeoutSeconds) throws IOException, InterruptedException {
    StringBuilder out = new StringBuilder();
    runLines(args, timeoutSeconds, (line) -> {
      if (out.length() > 0) out.append('\n');
      out.append(line);
    });
    return out.toString().trim();
  }

  public void runLines(List<String> args, long timeoutSeconds, Consumer<String> onLine)
      throws IOException, InterruptedException {
    Path exe = binary.resolve();
    List<String> command = new ArrayList<>();
    command.add(exe.toString());
    command.addAll(args);
    Process process = new ProcessBuilder(command).start();
    ByteArrayOutputStream stderr = new ByteArrayOutputStream();
    Thread errThread = new Thread(() -> copy(process.getErrorStream(), stderr), "agent-stderr");
    errThread.setDaemon(true);
    errThread.start();
    try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) onLine.accept(line);
    }
    errThread.join(5_000);
    boolean done = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
    if (!done) {
      process.destroyForcibly();
      throw new IOException("agent timed out");
    }
    if (process.exitValue() != 0) {
      String err = stderr.toString(StandardCharsets.UTF_8).trim();
      if (!err.isBlank()) throw new IOException(err);
    }
  }

  private static void copy(InputStream in, ByteArrayOutputStream out) {
    try (in) {
      in.transferTo(out);
    } catch (IOException ignored) {
      // process ended
    }
  }
}
