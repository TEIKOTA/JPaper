// 契約付録 §5「Windows」。issue #462
import { describe, expect, it, vi } from "vitest";
import { killChild, killTree, resolveCommand, ShimError, spawnOptions } from "./spawn-cli.mjs";

// npm の cmd-shim が node_modules/.bin や prefix に置く .cmd。
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

// npm の cmd-shim 9 が生成した実物（行末は CRLF）。
const NPM_CODEX =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';

// pnpm（@zkochan/cmd-shim）の .cmd。
const PNPM_SHIM = `@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\node_modules"
) ELSE (
  @SET "NODE_PATH=%NODE_PATH%;C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\node_modules"
)
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*
)
`;

const win = (files, env = { Path: "C:\\bin;C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" }) => ({
  platform: "win32",
  env,
  exists: (p) => p in files,
  read: (p) => files[p],
  execPath: "C:\\node\\node.exe",
});

describe("resolveCommand", () => {
  it("Windows 以外では名前をそのまま返す", () => {
    expect(resolveCommand("claude", ["-p"], { platform: "linux" })).toEqual({ command: "claude", args: ["-p"] });
  });

  it("Windows では PATH の .exe を直接起動する", () => {
    const deps = win({ "C:\\npm\\claude.exe": "" });
    expect(resolveCommand("claude", ["-p"], deps)).toEqual({ command: "C:\\npm\\claude.exe", args: ["-p"] });
  });

  it("PATH の前の dir と PATHEXT の順を優先する", () => {
    const deps = win({ "C:\\bin\\pnpm.cmd": PNPM_SHIM, "C:\\bin\\pnpm.exe": "", "C:\\npm\\pnpm.exe": "" });
    expect(resolveCommand("pnpm", [], deps).command).toBe("C:\\bin\\pnpm.exe");
  });

  it("npm の .cmd は中の JS を node で直接起動する（改行を含む引数も cmd.exe を通さない）", () => {
    const deps = win({ "C:\\npm\\claude.cmd": NPM_SHIM });
    expect(resolveCommand("claude", ["--append-system-prompt", "一行目\n\"二行目\" %PATH%"], deps)).toEqual({
      command: "C:\\node\\node.exe",
      args: [
        "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
        "--append-system-prompt",
        "一行目\n\"二行目\" %PATH%",
      ],
    });
  });

  it("pnpm の .cmd は最後の対象の JS を node で起動する", () => {
    const deps = win({ "C:\\npm\\codex.cmd": PNPM_SHIM });
    expect(resolveCommand("codex", ["exec"], deps)).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\npm\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js", "exec"],
    });
  });

  it("環境変数の名前の大小を問わず PATH を読む", () => {
    const deps = win({ "C:\\x\\latexmk.exe": "" }, { PATH: "C:\\x" });
    expect(resolveCommand("latexmk", [], deps).command).toBe("C:\\x\\latexmk.exe");
  });

  it("見つからなければ名前のまま返し、spawn の ENOENT に任せる", () => {
    expect(resolveCommand("claude", ["-p"], win({}))).toEqual({ command: "claude", args: ["-p"] });
  });

  it("npm・pnpm の shim でない .cmd は理由つきで失敗する", () => {
    const deps = win({ "C:\\npm\\claude.cmd": "@echo off\r\nC:\\tools\\claude-real.exe %*\r\n" });
    expect(() => resolveCommand("claude", [], deps)).toThrow(ShimError);
  });

  it("shim の対象が JS でも exe でもなければ理由つきで失敗する", () => {
    const shim = NPM_SHIM.replace("cli.js", "cli.sh").replace(/_prog=node/g, "_prog=sh").replace("node.exe", "sh.exe");
    expect(() => resolveCommand("claude", [], win({ "C:\\npm\\claude.cmd": shim }))).toThrow(ShimError);
  });

  it("npm の claude（対象が exe の shim）は exe を直接起動する", () => {
    const shim = NPM_CODEX.replace(/\r\n\r\nIF EXIST[\s\S]*$/, '\r\n\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
    expect(resolveCommand("claude", ["-p"], win({ "C:\\npm\\claude.cmd": shim }))).toEqual({
      command: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
      args: ["-p"],
    });
  });

  it("npm の実物の shim（CRLF、起動行に PATHEXT の設定）を node で起動する", () => {
    expect(resolveCommand("codex", ["exec"], win({ "C:\\npm\\codex.cmd": NPM_CODEX }))).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "exec"],
    });
  });

  it("pnpm が別ドライブに置いた絶対パスの対象も読む", () => {
    const shim = PNPM_SHIM.replaceAll("%~dp0\\global", "D:\\pnpm\\global").replaceAll('"%~dp0\\node.exe"', '"%~dp0\\node.exe"');
    expect(resolveCommand("codex", [], win({ "C:\\npm\\codex.cmd": shim })).args[0]).toBe(
      "D:\\pnpm\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js",
    );
  });

  it.each([
    ["環境変数を設定する shim", NPM_SHIM.replace("SETLOCAL\n", "SETLOCAL\n@SET FOO=1\n")],
    ["node に追加の引数を渡す shim", NPM_SHIM.replace('"%_prog%"  "', '"%_prog%" --no-warnings "')],
    ["node 以外で起動する shim", NPM_SHIM.replace(/_prog=node"/, '_prog=sh"').replace(/_prog=%dp0%\\node\.exe"/, '_prog=%dp0%\\sh.exe"')],
    ["対象 C:\\npm\\node_modules\\pnpm\\bin\\pnpm が exe でない", NPM_SHIM.replace(/"%_prog%"\s+"%dp0%\\[^"]+"/, '"%dp0%\\node_modules\\pnpm\\bin\\pnpm"')],
  ])("%s は理由つきで失敗する", (why, shim) => {
    expect(() => resolveCommand("x", [], win({ "C:\\npm\\x.cmd": shim }))).toThrow(new ShimError(`C:\\npm\\x.cmd を直接起動できません（${why}）`));
  });
});

describe("spawnOptions", () => {
  it("Windows 以外では変えない", () => {
    const opts = { detached: true, cwd: "/b" };
    expect(spawnOptions(opts, "darwin")).toBe(opts);
  });

  it("Windows では detached を外し、コンソールを開かない", () => {
    expect(spawnOptions({ detached: true, cwd: "C:\\b" }, "win32")).toEqual({ detached: false, windowsHide: true, cwd: "C:\\b" });
  });
});

describe("killTree / killChild", () => {
  it("POSIX ではプロセスグループに送り、無ければ pid に送る", () => {
    const kill = vi.fn((pid) => {
      if (pid < 0) throw new Error("ESRCH");
    });
    killTree(42, "SIGTERM", { platform: "linux", kill });
    expect(kill.mock.calls).toEqual([
      [-42, "SIGTERM"],
      [42, "SIGTERM"],
    ]);
  });

  it("Windows では taskkill でツリーごと止める", () => {
    const run = vi.fn();
    killTree(42, "SIGTERM", { platform: "win32", run });
    expect(run).toHaveBeenCalledWith("taskkill", ["/pid", "42", "/T", "/F"], { stdio: "ignore", windowsHide: true });
  });

  it("pid が無ければ何もしない", () => {
    const run = vi.fn();
    const kill = vi.fn();
    killTree(undefined, "SIGKILL", { platform: "win32", run });
    killTree(undefined, "SIGKILL", { platform: "linux", kill });
    killChild({ pid: undefined, kill }, "SIGKILL", { platform: "win32", run });
    expect(run).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("killChild は POSIX では子だけに送り、Windows ではツリーを止める", () => {
    const child = { pid: 7, kill: vi.fn() };
    killChild(child, "SIGTERM", { platform: "darwin" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    const run = vi.fn();
    killChild(child, "SIGTERM", { platform: "win32", run });
    expect(run).toHaveBeenCalledWith("taskkill", ["/pid", "7", "/T", "/F"], { stdio: "ignore", windowsHide: true });
  });
});
