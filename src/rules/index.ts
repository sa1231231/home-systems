export { evaluateCondition, getField, InvalidConditionError, validateCondition } from "./dsl.js";
export type { Cond, Op } from "./dsl.js";
export { evaluate, loadEnabledRules, pickFirstMatch } from "./engine.js";
export type { Match, RuleRow } from "./engine.js";
