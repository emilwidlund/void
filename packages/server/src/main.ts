import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { createServer } from "node:http"
import { AppLive } from "./Http.js"

const port = Number(process.env.PORT ?? 4000)

const ServerLive = AppLive.pipe(
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port }))
)

NodeRuntime.runMain(Layer.launch(ServerLive))
