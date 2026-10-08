/** Payload the ingress function hands to the worker (async Lambda invoke). */
export type WorkerJob =
  | {
      kind: 'mention';
      channel: string;
      threadTs: string;
      triggerText: string;
    }
  | {
      kind: 'command';
      channel: string;
      /** Present only when Slack included thread context with the command. */
      threadTs?: string;
      triggerText: string;
      /** Slack response_url: valid for 30 minutes, needs no token. */
      responseUrl: string;
    };
