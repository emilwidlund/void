import { Command } from "@effect/cli"
import { buildCommand } from "./commands/build.js"
import { checkCommand } from "./commands/check.js"
import { deployCommand } from "./commands/deploy.js"
import { fmtCommand } from "./commands/fmt.js"
import { initCommand } from "./commands/init.js"

const command = Command.make("void").pipe(
  Command.withSubcommands([initCommand, checkCommand, buildCommand, deployCommand, fmtCommand])
)

export const cli = Command.run(command, {
  name: "void",
  version: "0.0.1"
})
