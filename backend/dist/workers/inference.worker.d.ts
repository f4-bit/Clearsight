import { Worker } from "bullmq";
import { InferenceJobData } from "./inference.queue.js";
export declare function startInferenceWorker(): Worker<InferenceJobData, any, string>;
