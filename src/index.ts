import { logger } from "./observability/logger";

logger.info("knoldr starting");

// Phase 2: A2A server, collection pipeline, observability endpoints
// For now, just log that we're ready
logger.info("knoldr ready (Phase 1: CLI mode only, run `knoldr --help` for usage)");
