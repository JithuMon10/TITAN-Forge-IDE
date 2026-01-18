export type IntentTask =
  | 'scan_anomalies'
  | 'explain_semantics'
  | 'verify_comments'
  | 'review_identifiers'
  | 'summarise_findings';

export interface IntentSignals {
  tasks: IntentTask[];
  anomalyScan: boolean;
  suspicionBias: boolean;
  clarificationQuestion: string | null;
  humanLanguageNotes: string[];
  suspectedIdentifiers: string[];
  highlightedComments: string[];
  idiomMatches: string[];
}

export interface CommentInsight {
  file: string;
  line: number;
  text: string;
}

export interface IdentifierInsight {
  file: string;
  identifier: string;
  score: number;
}

export interface IntentAnalysisResult extends IntentSignals {
  commentInsights: CommentInsight[];
  identifierInsights: IdentifierInsight[];
}

const AMBIGUOUS_PHRASES = [
  'fishy',
  'weird',
  'hidden',
  'anything off',
  'smell',
  'sus',
  'odd',
  'strange',
  'suspicious'
];

const META_QUESTIONS = [
  'do you see anything',
  'spot anything',
  'notice anything',
  'anything unusual',
  'anything you find'
];

const IDIOM_PATTERNS = [
  /kick the bucket/i,
  /piece of cake/i,
  /break a leg/i,
  /once in a blue moon/i,
  /spill the beans/i,
  /under the weather/i,
  /wild goose chase/i,
  /strings attached/i,
  /easter egg/i,
  /rickroll/i,
  /yolo/i,
  /lol/i,
  /lmao/i,
  /wtf/i,
  /hacky/i
];

const CLARIFY_PHRASES = [
  'help',
  'assist',
  'support'
];

const DOMAIN_WORDS = new Set(
  [
    'function',
    'class',
    'component',
    'module',
    'service',
    'controller',
    'util',
    'helper',
    'request',
    'response',
    'error',
    'warning',
    'test',
    'client',
    'server',
    'build',
    'deploy',
    'auth',
    'token',
    'config',
    'settings',
    'data',
    'file',
    'buffer',
    'stream',
    'promise',
    'async',
    'await',
    'render'
  ]
);

const COMMON_ENGLISH = new Set(
  [
    'about',
    'after',
    'again',
    'almost',
    'also',
    'always',
    'because',
    'before',
    'between',
    'can',
    'could',
    'even',
    'first',
    'found',
    'great',
    'hello',
    'maybe',
    'never',
    'should',
    'since',
    'some',
    'their',
    'there',
    'these',
    'thing',
    'those',
    'through',
    'under',
    'where',
    'which',
    'would'
  ]
);

function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((entry) => normaliseWhitespace(entry))
    .filter((entry) => entry.length > 0);
}

function extractIdentifiers(content: string): string[] {
  const candidates = content.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g);
  if (!candidates) {
    return [];
  }
  return Array.from(new Set(candidates));
}

function looksNonDomain(word: string): boolean {
  const lower = word.toLowerCase();
  if (DOMAIN_WORDS.has(lower) || COMMON_ENGLISH.has(lower)) {
    return false;
  }
  if (lower.length <= 4) {
    return false;
  }
  if (/^[0-9_]+$/.test(lower)) {
    return false;
  }
  if (/^[a-z]+\d+$/.test(lower)) {
    return false;
  }
  const vowels = lower.replace(/[^aeiou]/g, '').length;
  const ratio = vowels / lower.length;
  // Further relaxed vowel ratio and length check.
  return ratio < 0.15 || /([a-z])\1{2,}/.test(lower) || (lower.length >= 10 && !/(ing|ion|able|ment|er|ed)$/.test(lower));
}

function extractComments(filePath: string, content: string): CommentInsight[] {
  const lines = content.split(/\r?\n/);
  const insights: CommentInsight[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^(\/\/|#|--)/.test(trimmed)) {
      const text = trimmed.replace(/^\/\/+|^#+|^--+/, '').trim();
      if (text.split(' ').length >= 4) {
        insights.push({ file: filePath, line: index + 1, text });
      }
    }
    const blockMatch = trimmed.match(/\/\*([^*]|\*(?!\/))*\*\//);
    if (blockMatch) {
      const extracted = blockMatch[0]
        .replace(/^\/\*+|\*+\/$/g, '')
        .replace(/^\s*\*+/gm, '')
        .trim();
      if (extracted.split(' ').length >= 4) {
        insights.push({ file: filePath, line: index + 1, text: extracted });
      }
    }
  });
  return insights;
}

function extractIdioms(content: string): string[] {
  const matches = new Set<string>();
  IDIOM_PATTERNS.forEach((pattern) => {
    if (pattern.test(content)) {
      matches.add(pattern.source);
    }
  });
  return Array.from(matches.values());
}

interface AnalysisOptions {
  forceAnomalyScan?: boolean;
}

export function analyzeIntent(
  userMessage: string,
  context: {
    editor?: { path: string; content: string };
    requestedFiles: { path: string; content: string }[];
  },
  options?: AnalysisOptions
): IntentAnalysisResult {
  const normalizedMessage = userMessage.trim().toLowerCase();
  const tasks: IntentTask[] = [];
  const commentInsights: CommentInsight[] = [];
  const identifierInsights: IdentifierInsight[] = [];
  const humanLanguageNotes = new Set<string>();
  const suspectedIdentifiersSet = new Set<string>();
  const idiomMatches = new Set<string>();

  const requiresAnomalyScan =
    options?.forceAnomalyScan === true ||
    AMBIGUOUS_PHRASES.some((phrase) => normalizedMessage.includes(phrase));

  if (requiresAnomalyScan) {
    tasks.push('scan_anomalies');
  }

  const suspicionBias = META_QUESTIONS.some((phrase) => normalizedMessage.includes(phrase));

  const shouldClarify = !requiresAnomalyScan &&
    CLARIFY_PHRASES.some((phrase) => normalizedMessage.includes(phrase)) &&
    normalizedMessage.split(' ').length <= 8;

  let clarificationQuestion: string | null = null;
  if (shouldClarify) {
    clarificationQuestion = 'Can you clarify what kind of issue you want me to investigate in this code?';
  }

  const filesToInspect = [];
  if (context.editor) {
    filesToInspect.push(context.editor);
  }
  context.requestedFiles.forEach((file) => filesToInspect.push(file));

  filesToInspect.forEach((file) => {
    const comments = extractComments(file.path, file.content);
    comments.forEach((comment) => {
      commentInsights.push(comment);
      humanLanguageNotes.add(comment.text);
    });

    if (comments.length > 0) {
      tasks.push('verify_comments');
    }

    const identifiers = extractIdentifiers(file.content);
    identifiers.forEach((identifier) => {
      if (looksNonDomain(identifier)) {
        suspectedIdentifiersSet.add(identifier);
        identifierInsights.push({ file: file.path, identifier, score: 1 });
      }
    });

    const idioms = extractIdioms(file.content);
    idioms.forEach((value) => idiomMatches.add(value));
  });

  const suspectedIdentifiers = Array.from(suspectedIdentifiersSet.values());
  if (suspectedIdentifiers.length > 0) {
    tasks.push('review_identifiers');
  }

  if (commentInsights.length > 0 || suspectedIdentifiers.length > 0) {
    tasks.push('explain_semantics');
  }

  if (tasks.length === 0) {
    tasks.push('summarise_findings');
  }

  const highlightedComments = commentInsights.map((entry) => `${entry.file}:${entry.line} ${entry.text}`);

  const idiomList = Array.from(idiomMatches.values());
  idiomList.forEach((match) => humanLanguageNotes.add(`Detected idiom or meme pattern: ${match}`));

  return {
    tasks: Array.from(new Set(tasks)),
    anomalyScan: requiresAnomalyScan,
    suspicionBias,
    clarificationQuestion,
    humanLanguageNotes: Array.from(humanLanguageNotes.values()),
    suspectedIdentifiers,
    highlightedComments,
    idiomMatches: idiomList,
    commentInsights,
    identifierInsights
  };
}
