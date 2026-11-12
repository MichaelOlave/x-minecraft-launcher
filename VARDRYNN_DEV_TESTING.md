# Testing a pack from the terminal

Vardrynn can stage a disposable copy of a working instance, swap in local mod builds, launch it, run the pack's own test harness and keep the evidence of every run. All of this works from a terminal **while Vardrynn is open**.

```sh
cd ~/Projects/experiments/MinecraftModPack
/Applications/Vardrynn.app/Contents/MacOS/Vardrynn test run veil-reload
```

That command builds the Veil companion, stages "Folded Multiverse Veil Test" from "Folded Multiverse" after checking it against `pack-lock.json`, launches the Veil Development world, runs the Veil harness and waits for a clean exit. It prints a run ID, the result of each phase and the folder that holds the evidence.

## Terminal commands while Vardrynn is open

A command typed in a terminal is sent to the launcher that is already running. Its output, progress and exit status come back to that terminal. If no launcher is running, the command starts one in the background (add `--no-window` to keep it hidden) and waits for it. `--help`, `--version` and usage errors are answered without a launcher.

- **Transport.** The running launcher listens on `<appData>/vardrynn/cli.sock` (a named pipe on Windows) and writes a fresh random token to `cli-token`, both readable only by the user. A command and the launcher each prove they know the token with an HMAC over the other side's nonce, so the token never crosses the socket and a process pretending to be the launcher learns nothing. Only the instance holding the single-instance lock serves commands.
- **Cancelling.** Ctrl+C cancels the command in the launcher. A second Ctrl+C exits at once.
- **Output.** By default, logs and tables go to stdout and progress to stderr. With `--json`, stdout carries only JSON lines: the command's own `{"ok": …, "command": …, "data": …}` envelopes, plus `{"type": "progress"}` and `{"type": "event"}` lines. Logs then go to stderr.
- **Multi-word commands** may be quoted (`'instance list'`) or not (`instance list`).

### Exit status

| Code | Meaning |
| --- | --- |
| 0 | Succeeded; a test run passed |
| 1 | Failed |
| 2 | Unknown command, unknown flag or invalid input |
| 10 | Setup failed: build step, lock check, staging or local mod plan |
| 11 | Minecraft did not start |
| 12 | Minecraft never opened its window (or crashed while loading) |
| 13 | The pack's harness reported a failure |
| 14 | Minecraft crashed, exited non-zero or had to be stopped |
| 69 | No launcher could be reached |
| 130 | Cancelled |

## Launch settings for one launch

`launch <instance>` accepts settings that apply to that launch only. `instance.json` is never edited, so the open launcher's view of the instance stays correct.

```sh
Vardrynn launch "Folded Multiverse Veil Test" --world "Veil Development" \
  --vm-option -Dveil.debug=true --max-memory 16384 --resolution 1280x720 --wait
```

`--vm-option`, `--mc-option` and `--env NAME=value` can repeat. JVM options are added after the instance's own; `--replace-vm-options` uses only the given ones, dropping the instance's (for example its garbage collector choice). With `--wait`, the command follows the game process and reports `started`, `ready` (the window appeared) and `exited` events, then exits with the game's outcome (11, 12 or 14 above). `--ready-timeout <seconds>` limits the wait for the window. `--stop-on-cancel` stops Minecraft on Ctrl+C or timeout; otherwise it keeps running. Without `--wait`, the JSON result includes the launch ID.

## Disposable instances

```sh
Vardrynn dev stage "Folded Multiverse" "Folded Multiverse Veil Test" \
  --lock pack-lock.json --lock-extra overrides/mods/folded-join-messages-0.1.0+1.21.1.jar \
  --exclude 'sentry-minecraft*' --world "testing/veil-development-client/saves/Veil Development"
```

- **Lock check.** With `--lock`, every jar in the working instance's `mods/` must match an active artifact of the lock by file name and SHA-256, and nothing may be extra or missing. `--lock-extra` names files newer than the lock. Hashes are cached by size and modification time.
- **Mods** are copy-on-write clones on APFS (and on Btrfs and XFS with reflinks), so they share disk space with the working instance but never its writes. Other file systems get a plain copy. Unchanged mods are not copied again.
- **Settings.** `config`, `defaultconfigs`, `kubejs`, `resourcepacks`, `datapacks`, `shaderpacks` and `options.txt` are copied once (`--copy-once` changes the list), so settings changed while testing survive a restage. `--fresh` copies them again.
- **Overlays.** `--overlay FROM=TO` copies files from the pack repository on every stage; `--replace-overlay` empties the destination first. Changed files are reported with their old and new hashes.
- **Worlds.** `--world` copies a fixture world into `saves/` fresh on every stage, unless `--keep-world`.
- **Safety.** A stage refuses an instance that it did not create, one with Minecraft running, symbolic links other than the launcher's own `libraries` and `versions` links, and `mods/` files it did not put there. The working instance is only read. The disposable instance carries `.vardrynn-dev.json`, which records what the stage owns.

## Local mod builds

```sh
Vardrynn dev stage "Folded Multiverse" "Folded Multiverse Veil Test" --lock pack-lock.json \
  --mod ~/Projects/personal/MinecraftMods/NonEuclideanPockets/build/libs/non-euclidean-pockets-*.jar --dry-run
```

`--mod` replaces the instance mod that declares the same **mod ID**, so a build whose file name differs from the pack's still replaces the right mod. `--add-mod` installs a mod the pack does not have. A `*` in the file name must match exactly one jar, not counting `-sources` and `-javadoc` jars. Mod IDs come from `neoforge.mods.toml`, `mods.toml`, `fabric.mod.json` or `quilt.mod.json`, cached by hash in `dev-cache/mod-ids.json`.

The plan is checked before anything changes. It fails when a build declares no mod ID, matches nothing without `--add-mod`, would overwrite an unrelated file, or would leave two files claiming one mod ID. Duplicates already in the pack are only warnings. The output lists each replaced file with both SHA-256 hashes. `--dry-run` prints the plan and changes nothing.

Every stage starts from the pack's own mods: builds installed by the previous stage are removed and the files they replaced are restored.

## Test scenarios

A pack repository declares scenarios in `vardrynn.tests.json` at its root. Paths are relative to that folder.

```json
{
  "version": 1,
  "scenarios": {
    "veil-reload": {
      "description": "…",
      "stage": { "source": "Folded Multiverse", "name": "Folded Multiverse Veil Test", "lock": { "file": "pack-lock.json" }, "mods": [{ "path": "veil-dev/build/libs/folded-veil-dev-0.1.0.jar", "add": true }] },
      "prepare": [["python3", "veil-dev/dev.py", "build"]],
      "afterStage": [["python3", "veil-dev/dev.py", "prepare-instance", "--client", "${VARDRYNN_INSTANCE}"]],
      "launch": { "world": "Veil Development", "vmOptions": ["-Dveil.debug=true"], "replaceVmOptions": true, "maxMemory": 16384 },
      "harness": { "command": ["python3", "testing/veil-development-harness/run_acceptance.py"], "timeout": 1800 },
      "afterHarness": "wait-for-exit",
      "timeouts": { "ready": 900, "exit": 180 }
    }
  }
}
```

`stage` takes the same fields as `dev stage`; `mods` entries may pin `modId`, `sha256` or `sha512`. `prepare` and `afterStage` commands run without a shell, in the pack folder. `${VARDRYNN_*}` in their arguments is replaced. Unknown keys are rejected so typos surface.

`test run <scenario>` runs one. `--mod` and `--add-mod` add local builds to the scenario's, `--user` picks the account, `--keep-world` keeps the last world and `--pack` points at the repository when not running from inside it. The **terminal process** runs the build steps and the harness, so they inherit the shell's environment (such as `JAVA_HOME`). The launcher never runs commands from a pack file.

### Phases

| Phase | Passes when | Fails with |
| --- | --- | --- |
| setup | build steps succeed, the lock matches and staging completes | 10 |
| start | the game process starts | 11 |
| ready | the game window appears within `timeouts.ready` | 12 (the game is stopped) |
| test | the harness reports PASS | 13 |
| exit | the game exits with status 0 within `timeouts.exit` | 14 |

The first failing phase sets the exit status. A game left running after a failed or cancelled run is stopped.

### Harness contract

The harness starts once the game window is ready, with these variables:

| Variable | Value |
| --- | --- |
| `VARDRYNN_RUN_ID`, `VARDRYNN_RUN_DIR` | The run and its evidence folder |
| `VARDRYNN_SCENARIO`, `VARDRYNN_PACK` | Scenario name and pack folder |
| `VARDRYNN_INSTANCE`, `VARDRYNN_INSTANCE_NAME`, `VARDRYNN_WORLD` | The staged instance and the world opened |
| `VARDRYNN_PID`, `VARDRYNN_LAUNCH_ID` | The game process and its launch ID |
| `VARDRYNN_LAUNCH_RECORD` | The launcher's `launch.json` for this launch; its `state` becomes `exited` with `exitCode` when the game closes |
| `VARDRYNN_RESULT` | Where to write the result |
| `VARDRYNN_EVIDENCE_DIR` | A folder for screenshots, probe logs and other evidence |

It reports by writing `{"result": "PASS" | "FAIL", "summary": "…", "checks": [{"name": "…", "result": "PASS" | "FAIL" | "SKIP", "detail": "…"}]}` to `VARDRYNN_RESULT`. A PASS only counts if the harness also exits 0 and no check failed. Without the file, its exit status decides. A harness running past `harness.timeout` is stopped and fails. Its output is shown in the terminal and saved to `harness.log`.

With `"afterHarness": "wait-for-exit"` (the default), the game must close on its own; the Veil harness quits it. `"stop-game"` stops the game once the harness passes. Without a harness, `stop-game` makes a startup smoke test: the run passes when the window appears.

## Evidence

Each run has a folder under `<appData>/vardrynn/test-runs/<run ID>/`. The newest 50 runs are kept. Evidence is copied when the run finishes, so later launches that overwrite `latest.log`, and the three-launch limit of launch history, do not affect it.

| File | Content |
| --- | --- |
| `run.json` | The run record: phases, outcome, stage result, launch, harness result |
| `summary.txt` | The summary printed at the end |
| `launch/launch.json`, `launch/launch-settings.json` | The launcher's launch record and the settings the game started with: Java path, version and vendor, heap, JVM and game arguments, added environment, command line. Credentials are redacted when recorded. |
| `logs/game.log`, `logs/debug.log`, `logs/launcher-output.log` | Game and process output for this launch |
| `logs/launcher.log` | The launcher's own log lines during the run |
| `crash/` | Crash reports and `hs_err_pid*.log` JVM crash files written during the run |
| `mods.json` | SHA-256 of every staged pack mod, local builds with the hashes they replaced, config overlay changes |
| `environment.json` | Launcher version, OS, CPU, memory and Java |
| `prepare.log`, `harness.log`, `harness/` | Build output, harness output and the harness's own evidence |

Every launch, not just test runs, now records `launch-settings.json` in its launch history folder.

`test runs` lists recent runs, `test show <run>` prints one, and `test export <run> [--out file.zip]` zips it for sharing. The export passes every text file through credential redaction (access tokens, `--xuid` and `--clientId` values, JWTs, bearer headers, secret-looking environment variables) and shows the home folder as `~`. Screenshots and other binary files are included unchanged.

## Development builds

To use these commands against a development launcher started by `pnpm dev:main`, run the development bundle with the repository's Electron:

```sh
xmcl-electron-app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron xmcl-electron-app/dist/index.js test run veil-reload
```

The development and packaged launchers share the data folder and single-instance lock, so only one of them runs at a time. Commands reach whichever is open.

## Not yet

Paired client and server runs, comparing two runs, and pack drift checks are planned next. Evidence already includes the mod hashes, launch settings and startup times that a comparison will need.
