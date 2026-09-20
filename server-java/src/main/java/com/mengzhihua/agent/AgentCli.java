package com.mengzhihua.agent;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Component;

@Component
public class AgentCli {
  private final AgentBinary binary;

  public AgentCli(AgentBinary binary) {
    this.binary = binary;
  }

  public String run(List<String> args, long timeoutSeconds) throws IOException, InterruptedException {
    Path exe = binary.resolve();
    List<String> command = new ArrayList<>();
    command.add(exe.toString());
    command.addAll(args);
    ProcessBuilder pb = new ProcessBuilder(command);
    Process process = pb.start();
    ByteArrayOutputStream stdout = new ByteArrayOutputStream();
    ByteArrayOutputStream stderr = new ByteArrayOutputStream();
    Thread errThread = new Thread(() -> copy(process.getErrorStream(), stderr), "agent-stderr");
    errThread.setDaemon(true);
    errThread.start();
    copy(process.getInputStream(), stdout);
    errThread.join(5_000);
    boolean done = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
    if (!done) {
      process.destroyForcibly();
      throw new IOException("agent timed out");
    }
    String text = stdout.toString(StandardCharsets.UTF_8).trim();
    if (process.exitValue() != 0 && text.isBlank()) {
      throw new IOException(stderr.toString(StandardCharsets.UTF_8).trim());
    }
    return text;
  }

  private static void copy(InputStream in, ByteArrayOutputStream out) {
    try (in) {
      in.transferTo(out);
    } catch (IOException ignored) {
      // process ended
    }
  }
}
