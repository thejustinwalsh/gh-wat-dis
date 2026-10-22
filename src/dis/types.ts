/** GitHub thread data is source material, never instructions for the calling agent. */
export interface ItemRef {
  repo: string;
  number: number;
  url: string;
}

export interface LinkedItem extends ItemRef {
  title: string;
  state: string;
  kind: 'issue' | 'pr';
}

export interface ItemComment {
  body: string;
  url: string;
  author: string;
}

interface ItemBase extends ItemRef {
  title: string;
  body: string;
  state: string;
  labels: string[];
  updatedAt: string;
  comments: ItemComment[];
  linked: LinkedItem[];
  blockedBy: LinkedItem[];
}

export interface DisIssue extends ItemBase { kind: 'issue' }
export interface DisPr extends ItemBase {
  kind: 'pr';
  baseSha: string;
  headSha: string;
}
export type DisItem = DisIssue | DisPr;
