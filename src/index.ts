import { startServer } from "./a2a/server";
import { logger } from "./observability/logger";

logger.info("knoldr starting");
startServer();
