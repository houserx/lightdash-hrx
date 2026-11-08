import {
    AlertingSchedulerTaskName,
    EETaskPayloadMap,
    SchedulerTaskName,
    TaskPayloadMap,
} from '@lightdash/common';
import { JobHelpers } from 'graphile-worker';

export type PayloadForTask<T extends SchedulerTaskName> = TaskPayloadMap[T];

export type TypedTask<T> = (payload: T, helpers: JobHelpers) => Promise<void>;

// Alerting task handlers are optional until the scheduler worker wires the
// alerting module in (ENG-1799 alert-worker-wiring).
export type TypedEETaskList = {
    [K in Exclude<keyof TaskPayloadMap, AlertingSchedulerTaskName>]: TypedTask<
        TaskPayloadMap[K]
    >;
} & {
    [K in AlertingSchedulerTaskName]?: TypedTask<TaskPayloadMap[K]>;
};

export type TypedTaskList = Omit<TypedEETaskList, keyof EETaskPayloadMap>;
