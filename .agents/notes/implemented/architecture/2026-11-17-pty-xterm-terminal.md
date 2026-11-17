# Agent Note: Interactive terminal uses a sandboxed PTY and xterm.js

Status: implemented

## Problem

The command-runner terminal could keep a working directory, but it could not support terminal editing, Tab completion, Ctrl+C, streaming output, colors, or interactive programs. A real terminal requires a controlling pseudo-terminal and a terminal emulator.

## Decision

The Desktop Host owns persistent PTY sessions through `node-pty`. The renderer renders them with xterm.js and sends raw terminal input through typed IPC.

Each terminal starts `/bin/zsh -i` inside the existing macOS Seatbelt sandbox. A per-terminal `ZDOTDIR` under the managed private temp root provides a controlled `.zshrc` with `compinit`, history, completion, and a compact `→ barn` prompt. The shell starts in the real Session working directory or the application working directory, so `pwd` reports real host paths while Seatbelt still restricts network and filesystem writes.

Terminal data and exit events stream from Host to renderer. Renderer input, resize, and disposal use validated IPC. Terminal sessions are bounded, disposed when their tab unmounts, and all sessions are terminated during app shutdown.

`electron-builder` unpacks `node-pty` from the asar and rebuilds it for Electron 45. The packaged macOS app is verified by running `pwd` through the packaged terminal.

## Alternatives considered

**Keep the command-level terminal.** Rejected because it cannot provide real Tab completion, Ctrl+C, environment persistence, or interactive programs.

**Use xterm.js without a PTY.** Rejected because it only simulates a terminal display; the shell still receives no TTY.

**Bundle a guest VM terminal.** Rejected for the default terminal because local file work needs direct access to the selected workspace. VM isolation remains a separate provider.

**Load user `.zshrc` unchanged.** Rejected because sandboxed startup cannot write oh-my-zsh caches and configuration, while broadening write access to the user's home weakens the boundary.

## Consequences

- Terminals have persistent cwd, environment, shell history, job control, Tab completion, Ctrl+C, colors, and streaming output.
- The terminal shell has network denied and workspace-bounded writes.
- macOS packaging must rebuild and sign `node-pty` and its helper binary.
- Interactive terminal is macOS-only until an enforcing Windows PTY sandbox is implemented.
- The controlled zsh configuration does not load the user's personal aliases or oh-my-zsh plugins.
