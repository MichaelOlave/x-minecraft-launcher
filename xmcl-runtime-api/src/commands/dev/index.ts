import { commands } from '../registry'
import { stageDevInstanceCommand } from './stage'
import {
  beginTestRunCommand,
  exportTestRunCommand,
  finishTestRunCommand,
  launchRecordPathCommand,
  listTestRunsCommand,
  recordTestRunCommand,
  runTestScenarioCommand,
  showTestRunCommand,
  stageForTestCommand,
} from './testRun'

export * from './shared'
export * from './stage'
export * from './scenario'
export * from './testRun'

/** Developer commands for pack authors. Idempotent. */
export function registerDevCommands() {
  for (const cmd of [
    stageDevInstanceCommand,
    runTestScenarioCommand,
    listTestRunsCommand,
    showTestRunCommand,
    exportTestRunCommand,
    beginTestRunCommand,
    recordTestRunCommand,
    finishTestRunCommand,
    launchRecordPathCommand,
    stageForTestCommand,
  ]) {
    if (!commands.has(cmd.id)) commands.register(cmd)
  }
}
