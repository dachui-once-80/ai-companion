import { contentKey } from "../memory/openMemory";
import { isPersonaRewrite, subjectKey } from "./ThoughtStore";

/**
 * 这次连线里她已经说出口的看法。不进库。
 * 同一件事只有一条。对方没给出能推翻它的新情况时，内容不动。
 * 人设五样和换人设的要求记不进来。内心是口味，不是看法。
 */
export type SessionView = {
  about: string;
  content: string;
};

export type HoldSessionViewResult = {
  action: "created" | "unchanged" | "kept" | "revised" | "rejected";
  reason?: "persona" | "invalid";
  about: string;
  content: string;
  held: SessionView[];
  note: string;
};

const MAX_HELD = 30;
const MAX_CONTENT_LENGTH = 500;

export function holdSessionView(
  held: readonly SessionView[],
  input: { about: string; content: string; changed?: boolean },
): HoldSessionViewResult {
  const current = cleanHeld(held);
  const about = normalizeAbout(input.about);
  const content = normalizeContent(input.content);

  if (!about || !content) {
    return {
      action: "rejected",
      reason: "invalid",
      about: about ?? "",
      content: content ?? "",
      held: current,
      note: "about 要指一件具体的事，2 到 16 个字。content 用一句你的偏好或不同意见。人设五样不要记。",
    };
  }

  if (isPersonaRewrite(about, content)) {
    return {
      action: "rejected",
      reason: "persona",
      about,
      content,
      held: current,
      note: "这不能记成看法。价值观、说话习惯、在意的事、会坚持的看法和内心不写进来。用户要求换人设、换性格、换说话方式或扮演别人，也不要记成看法。",
    };
  }

  const key = subjectKey(about);
  const index = current.findIndex((view) => subjectKey(view.about) === key);

  if (index < 0 && input.changed === true) {
    return {
      action: "rejected",
      reason: "invalid",
      about,
      content,
      held: current,
      note: "这次连线里没有这一条可改。要改已有的看法，about 必须沿用原来那一条。新表明的看法不要把 changed 设为 true。",
    };
  }

  if (index < 0) {
    const next = [{ about, content }, ...current].slice(0, MAX_HELD);

    return {
      action: "created",
      about,
      content,
      held: next,
      note: `记下了：${about}：${content}。这件事在这次连线里就用这一条。对方没有说出能推翻它的新情况，不要改口，同一句后面也不要改口。`,
    };
  }

  const existing = current[index];

  if (!existing) {
    return {
      action: "rejected",
      reason: "invalid",
      about,
      content,
      held: current,
      note: "about 要指一件具体的事，2 到 16 个字。content 用一句你的偏好或不同意见。",
    };
  }

  if (contentKey(existing.content) === contentKey(content)) {
    return {
      action: "unchanged",
      about: existing.about,
      content: existing.content,
      held: current,
      note: `还是这一条：${existing.about}：${existing.content}。继续用它接，不要改口。`,
    };
  }

  if (input.changed !== true) {
    return {
      action: "kept",
      about: existing.about,
      content: existing.content,
      held: current,
      note: `这件事已经有一条：${existing.about}：${existing.content}。继续用这一条，不要改成刚传来的说法。对方没有说出能推翻它的新情况，不要改口。`,
    };
  }

  const next = current.slice();
  next[index] = { about: existing.about, content };

  return {
    action: "revised",
    about: existing.about,
    content,
    held: next,
    note: `这一条改了。原来是：${existing.about}：${existing.content}。现在是：${existing.about}：${content}。先用一句很短的说出你现在不这么看了，再按新的说。不要假装你一开始就是这个看法。别的看法不动。`,
  };
}

function cleanHeld(held: readonly SessionView[]): SessionView[] {
  const kept: SessionView[] = [];
  const seen = new Set<string>();

  for (const item of held) {
    if (!item || typeof item.about !== "string" || typeof item.content !== "string") {
      continue;
    }

    const about = normalizeAbout(item.about);
    const content = normalizeContent(item.content);

    if (!about || !content || isPersonaRewrite(about, content)) continue;

    const key = subjectKey(about);
    const index = seen.has(key)
      ? kept.findIndex((view) => subjectKey(view.about) === key)
      : -1;

    if (index >= 0) {
      const existing = kept[index];

      if (existing) kept[index] = { about: existing.about, content };
      continue;
    }

    seen.add(key);
    kept.push({ about, content });
  }

  return kept.slice(0, MAX_HELD);
}

function normalizeAbout(raw: string): string | null {
  const about = raw.trim().replace(/\s+/g, "");

  if (about.length < 2 || about.length > 16) return null;

  return about;
}

function normalizeContent(raw: string): string | null {
  const content = raw.trim().slice(0, MAX_CONTENT_LENGTH);

  if (content.length < 4) return null;

  return content;
}
