import { startServer } from "./a2a/server";
import { logger } from "./observability/logger";
import { configureOnnxRuntime } from "./llm/onnx-env";

logger.info("knoldr starting");

// Configure onnxruntime thread pool BEFORE any model import so the
// setting takes effect on the first NLI / reranker / QA load.
await configureOnnxRuntime();

startServer();
