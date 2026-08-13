import { Command } from "@effect/cli"
import { Console } from "effect"

export const initCommand = Command.make("init", {}, () =>
  Console.log("hello world")
)
