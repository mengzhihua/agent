import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findChrome } from "../src/browser/chrome.js";
import { doctorReport } from "../src/doctor.js";
import { chromeCandidates, defaultShell, whichProgram } from "../src/platform.js";
import { packageVersion } from "../src/version.js";

describe("platform", () => {
  it("resolves node on PATH", () => {
    const found = whichProgram(process.platform === "win32" ? "node.exe" : "node") ?? whichProgram("node");
    expect(found).toBeTruthy();
    expect(fs.existsSync(found!)).toBe(true);
  });

  it("picks a shell for this OS", () => {
    const shell = defaultShell();
    if (process.platform === "win32") {
      expect(shell.argsPrefix).toContain("/c");
      expect(shell.command.toLowerCase()).toMatch(/cmd|powershell/);
    } else {
      expect(shell.argsPrefix).toEqual(["-c"]);
      expect(shell.command).toMatch(/sh|bash|zsh/);
    }
  });

  it("lists chrome candidates for the OS", () => {
    const list = chromeCandidates();
    if (process.platform === "darwin") {
      expect(list.some((item) => item.includes("Google Chrome.app"))).toBe(true);
    } else if (process.platform === "win32") {
      expect(list.some((item) => item.toLowerCase().includes("chrome.exe"))).toBe(true);
    } else {
      expect(list).toContain("google-chrome");
    }
  });

  it("finds an explicit browser binary path", () => {
    const fake = path.join(os.tmpdir(), `fake-chrome-${process.pid}`);
    fs.writeFileSync(fake, "");
    expect(findChrome(fake)).toBe(fake);
    fs.unlinkSync(fake);
  });
});

describe("doctor", () => {
  it("reports version, os, sandbox, and browser", () => {
    const out = doctorReport();
    expect(out).toContain(`agent ${packageVersion()}`);
    expect(out).toContain(`os ${process.platform}`);
    expect(out).toMatch(/sandbox (bwrap|none)/);
    expect(out).toMatch(/browser (chrome|html)/);
  });
});
