import { startServer } from "./a2a/server";
import { startScheduler, startBatchDedup } from "./collect/scheduler";
import { logger } from "./observability/logger";

logger.info("knoldr starting");
startServer();
startScheduler();
startBatchDedup();
