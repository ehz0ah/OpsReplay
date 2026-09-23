/* Generated from JSON Schema by npm run contracts:generate. Do not edit. */

export type Expression =
  | {
      literal: number | boolean | string;
    }
  | {
      ref: string;
    }
  | {
      arg: string;
    }
  | {
      op:
        | 'add'
        | 'sub'
        | 'mul'
        | 'min'
        | 'max'
        | 'eq'
        | 'gte'
        | 'gt'
        | 'lt'
        | 'and'
        | 'or'
        | 'not'
        | 'if';
      /**
       * @maxItems 20
       */
      args: Expression[];
    };

export interface Scenario {
  schemaVersion: '0.1.0';
  id: string;
  version: string;
  engineVersion: string;
  title: string;
  status: 'draft' | 'published';
  difficulty: 'easy' | 'medium' | 'hard';
  domain: string;
  access: 'free' | 'practice';
  tickSeconds: number;
  /**
   * @maxItems 20
   */
  learningObjectives: string[];
  provenance: {
    kind: 'synthetic' | 'adapted';
    /**
     * @maxItems 100
     */
    sources: {
      title: string;
      url: string;
    }[];
    notes: string;
  };
  /**
   * @maxItems 30
   */
  services: string[];
  variables: {
    [k: string]:
      | {
          type: 'integer';
          minimum: number;
          maximum: number;
        }
      | {
          type: 'boolean';
        };
  };
  initialState: {
    [k: string]: number | boolean;
  };
  /**
   * @maxItems 100
   */
  initialEvidence: string[];
  /**
   * @maxItems 100
   */
  evidence: {
    id: string;
    kind:
      'alert' | 'metric' | 'logs' | 'deployments' | 'diff' | 'runbook' | 'architecture' | 'status';
    title: string;
    data: {
      [k: string]: unknown;
    };
  }[];
  /**
   * @maxItems 100
   */
  actions: {
    id: string;
    label: string;
    tool:
      | 'get_metric'
      | 'query_logs'
      | 'list_deployments'
      | 'inspect_diff'
      | 'read_runbook'
      | 'view_architecture'
      | 'get_service_status'
      | 'rollback_deployment'
      | 'scale_service'
      | 'restart_service'
      | 'advance_time';
    arguments: {
      [k: string]: unknown;
    };
    costTicks: number;
    costFromArgument?: 'ticks';
    prerequisite: Expression;
    /**
     * @maxItems 30
     */
    effects: {
      target: string;
      value: Expression;
    }[];
    /**
     * @maxItems 100
     */
    reveals: string[];
    /**
     * @maxItems 100
     */
    requiresEvidence: string[];
  }[];
  /**
   * @maxItems 100
   */
  tickRules: {
    target: string;
    value: Expression;
  }[];
  /**
   * @maxItems 50
   */
  metrics: {
    service: string;
    metric: string;
    unit: string;
    alwaysVisible: boolean;
    expression: Expression;
  }[];
  /**
   * @maxItems 50
   */
  eventRules: {
    id: string;
    when: Expression;
    message: string;
  }[];
  impact: Expression;
  resolution: Expression;
  failure: Expression;
  /**
   * @maxItems 2
   */
  checkpoints: {
    id: string;
    label: string;
    trigger: 'start' | 'before_first_mitigation';
  }[];
  debrief: {
    rootCause: string;
    /**
     * @maxItems 100
     */
    causalChain: string[];
    /**
     * @maxItems 100
     */
    keyEvidence: string[];
    /**
     * @maxItems 100
     */
    recommendedActions: string[];
    explanation: string;
  };
}
