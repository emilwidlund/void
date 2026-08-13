import { Command } from "@effect/cli"
import { buildCommand } from "./commands/build.js"
import { checkCommand } from "./commands/check.js"
import { initCommand } from "./commands/init.js"

const command = Command.make("void").pipe(
  Command.withSubcommands([initCommand, checkCommand, buildCommand])
)

export const cli = Command.run(command, {
  name: "void",
  version: "0.0.1"
})
