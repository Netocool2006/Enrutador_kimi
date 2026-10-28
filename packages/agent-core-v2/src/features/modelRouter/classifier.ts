export type RouterTier = 'T0' | 'T1' | 'T2' | 'T3';

export const ROUTER_TIERS: readonly RouterTier[] = ['T0', 'T1', 'T2', 'T3'];

export const ROUTER_TIER_ORDER: Record<RouterTier, number> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
};

export interface Classification {
  readonly tier: RouterTier;
  readonly uncertain: boolean;
  readonly reasons: readonly string[];
}

export interface ClassifierOptions {
  readonly riskKeywords?: readonly string[];
  readonly roundUpWhenUncertain?: boolean;
}

type SignalTable = Record<RouterTier, readonly (readonly [string, RegExp])[]>;

const TASK_SIGNALS: SignalTable = {
  T0: [
    ['lookup', /\b(find|locate|where is|search for|look up|list (the )?files?)\b/i],
    ['lookup-es', /\b(busca|encuentra|localiza|dónde está|lista (los )?archivos?)\b/i],
    ['rename', /\brename\b/i],
    ['rename-es', /\brenombra\b/i],
    ['typo', /\b(typo|misspell|spelling)\b/i],
    ['format', /\b(format|indent|lint[- ]?fix|prettier)\b/i],
    ['explain', /\b(explain|what does|how do(es)? .+ work|summari[sz]e|describe)\b/i],
    ['explain-es', /\b(explica|qué hace|cómo funciona|resume|resumen|describe)\b/i],
  ],
  T1: [
    [
      'small-change',
      /\b(fix|correct|adjust|tweak|update)\b[^.\n]*(small|simple|single|one file|default|comment|doc)/i,
    ],
    [
      'small-change-es',
      /\b(arregla|corrige|ajusta|actualiza)\b[^.\n]*(pequeñ|sencill|único|un archivo|simple)/i,
    ],
    ['add-test', /\b(add|write|create)\b[^.\n]*(unit )?tests?\b/i],
    ['add-test-es', /\b(añade|crea|escribe)\b[^.\n]*(prueba|test)\b/i],
    ['small-feature', /\b(small|simple|quick|minor)\b[^.\n]*(feature|function|helper|flag|option|field)/i],
    ['small-feature-es', /\b(pequeñ|sencill|simple|rápid)\b[^.\n]*(función|helper|opción|campo|característica)/i],
    ['docs', /\b(document|docs?|readme|changelog|javadoc|jsdoc)\b/i],
  ],
  T2: [
    ['debug', /\b(debug|debugging|troubleshoot|root cause|stack ?trace|crash(es)?\b)\b/i],
    ['debug-es', /\b(depura|depuración|fallo|traza|error esquivo|que se reproduce)\b/i],
    ['hard-debug', /\b(intermittent|flaky|sporadic|heisenbug|only (fails|when)|cannot reproduce|non.?deterministic)\b/i],
    ['concurrency', /\b(concurrency|race condition|deadlock|thread(ing|s)?|parallel(ism)?|async|lock(ing)?)\b/i],
    ['concurrency-es', /\b(concurrencia|carrera|punto de carrera|bloqueo|hilo(s)?|paralel)\b/i],
    ['performance', /\b(performance|optimi[sz]e|profil(e|ing)|slow|latency|memory leak|throughput|bottleneck)\b/i],
    ['performance-es', /\b(rendimiento|optimiza|lento|latencia|fuga de memoria|cuello de botella)\b/i],
    ['multi-module', /\b(multi[- ]?module|multiple modules|cross[- ]?cutting|several (files|modules)|many (files|modules)|across (the )?codebase)\b/i],
    ['multi-module-es', /\b(varios (módulos|archivos)|múltiples (módulos|archivos)|transversal)\b/i],
    ['refactor', /\brefactor(ing)?\b/i],
    ['migration-code', /\bmigrat(e|ion)\b(?!.*\b(schema|database|db)\b)/i],
  ],
  T3: [
    ['architecture', /\b(architecture|architectural|redesign|re[- ]?architect|from scratch|ground up)\b/i],
    ['architecture-es', /\b(arquitectura|rediseñ|diseño global|desde cero)\b/i],
    ['design-decision', /\b(design decision|tech (stack|choice|selection)|choose (the )?(technology|stack|approach)|evaluate (the )?(approach|options|tradeoffs?))\b/i],
    ['ambiguous', /\b(ambiguous|unclear|vague|unsure|don'?t (know|understand)|no idea|requirements? (is|are) unclear)\b/i],
    ['ambiguous-es', /\b(ambigü|ambiguo|poco claro|no (sé|entiendo)|requisitos? (poco claros|indefinidos))\b/i],
    ['persistent', /\b(persistent|persistently|keeps? failing|still failing|keeps? breaking|recurring|long[- ]standing)\b/i],
    ['persistent-es', /\b(persistente|sigue fallando|sigue rompiendo|recurrente|crónico)\b/i],
    ['high-risk', /\b(high[- ]?risk|breaking (everything|the build)|regression[- ]?prone|critical (change|decision)|production outage)\b/i],
    ['high-risk-es', /\b(alto riesgo|riesgo alto|cambio crítico|decisión crítica)\b/i],
    ['strategy', /\b(strategy|roadmap|planning the|large[- ]scale|big[- ]bang)\b/i],
  ],
};

const DEFAULT_RISK_KEYWORDS: readonly string[] = [
  'security',
  'vulnerability',
  'cve',
  'auth',
  'authentication',
  'authorization',
  'credential',
  'password',
  'secret',
  'token',
  'crypto',
  'encrypt',
  'billing',
  'payment',
  'persist',
  'persistence',
  'database schema',
  'concurrenc',
  'race condition',
  'deadlock',
  'seguridad',
  'autenticación',
  'autorización',
  'credencial',
  'contraseña',
  'persistencia',
  'concurrencia',
];

const MULTI_STEP_MARKERS = [
  /\n\s*(?:[-*]|\d+[.)])\s+\S/,
  /\b(and then|after that|then also|in addition|along with)\b/i,
  /\balso (update|fix|add|change|remove|refactor|migrate)\b/i,
  /\b(y luego|después de eso|además)\b/i,
  /\btambién (actualiza|arregla|añade|cambia|elimina)\b/i,
] as const;

const SHORT_CHAT_WORD_LIMIT = 8;

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

function maxMatchedTier(
  text: string,
  table: SignalTable,
): { tier: RouterTier; reasons: string[]; matched: boolean } {
  let order = -1;
  const reasons: string[] = [];
  for (const tier of ROUTER_TIERS) {
    for (const [label, pattern] of table[tier]) {
      if (!pattern.test(text)) continue;
      if (ROUTER_TIER_ORDER[tier] > order) {
        order = ROUTER_TIER_ORDER[tier];
        reasons.length = 0;
        reasons.push(`signal:${label}`);
      } else if (ROUTER_TIER_ORDER[tier] === order) {
        reasons.push(`signal:${label}`);
      }
    }
  }
  if (order < 0) return { tier: 'T0', reasons, matched: false };
  return { tier: ROUTER_TIERS[order]!, reasons, matched: true };
}

export function nextTier(tier: RouterTier): RouterTier | undefined {
  const order = ROUTER_TIER_ORDER[tier];
  return order >= 3 ? undefined : ROUTER_TIERS[order + 1];
}

export function classifyTask(text: string, options?: ClassifierOptions): Classification {
  const words = wordCount(text);
  const base = maxMatchedTier(text, TASK_SIGNALS);
  const reasons = [...base.reasons];
  let tier = base.tier;
  let uncertain = false;

  if (!base.matched) {
    uncertain = true;
    tier = words <= SHORT_CHAT_WORD_LIMIT ? 'T0' : 'T1';
    reasons.push('no-signal');
    if (words > SHORT_CHAT_WORD_LIMIT && (options?.roundUpWhenUncertain ?? true)) {
      tier = nextTier(tier) ?? tier;
      reasons.push('uncertain-round-up');
    }
  } else {
    const markers = MULTI_STEP_MARKERS.filter((pattern) => pattern.test(text)).length;
    const longMultiStep = words > 60;
    if ((markers >= 2 || (markers >= 1 && longMultiStep)) && tier !== 'T3') {
      tier = nextTier(tier) ?? tier;
      reasons.push('multi-step');
    }
  }

  const riskTerms = options?.riskKeywords ?? DEFAULT_RISK_KEYWORDS;
  const lowered = text.toLowerCase();
  const hit = riskTerms.find((keyword) => lowered.includes(keyword.toLowerCase()));
  if (hit !== undefined && ROUTER_TIER_ORDER[tier] < ROUTER_TIER_ORDER.T2) {
    tier = 'T2';
    reasons.push(`risk:${hit}`);
  }

  return { tier, uncertain, reasons };
}
