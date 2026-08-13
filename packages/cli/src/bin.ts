#!/usr/bin/env node
import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { cli } from "./Cli.js"

cli(process.argv).pipe(
  Effect.provide([NodeContext.layer, NodeHttpClient.layer]),
  NodeRuntime.runMain
)
