export type Align = 'left' | 'center' | 'right';

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: ReadonlyArray<string> }
  | { kind: 'code'; lang: string | null; body: string }
  | {
      kind: 'table';
      header: ReadonlyArray<string>;
      aligns: ReadonlyArray<Align>;
      rows: ReadonlyArray<ReadonlyArray<string>>;
    }
  | { kind: 'blank' };

export type InlineTok =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'link'; label: string; url: string };
