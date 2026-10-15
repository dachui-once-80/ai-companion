import { formatDate } from "../formatDate";
import type { LastTalk } from "./lastTalk";

export default function TalkPage({ talk }: { talk: LastTalk | null }) {
  const unfinishedId = unfinishedLineId(talk);

  return (
    <section className="companion-panel talk-page">
      <a className="page-back" href="#meet">
        回到她这里
      </a>

      <h1>那次对话</h1>

      {!talk || talk.lines.length === 0 ? (
        <p className="companion-subtitle">还没有可翻的对话。</p>
      ) : (
        <>
          <p className="companion-subtitle">
            {formatDate(talk.startedAt)}
            {talk.endedAt ? ` 到 ${formatDate(talk.endedAt)}` : ""}
          </p>

          <div className="talk-log">
            {talk.lines.map((line) => (
              <p className="transcript-line" key={`${line.id}-${line.speaker}`}>
                <span>{line.speaker}：</span>
                {line.text}
                {line.id === unfinishedId ? (
                  <em className="unfinished-mark">没说完</em>
                ) : null}
              </p>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function unfinishedLineId(talk: LastTalk | null): number | null {
  if (!talk?.unfinished) return null;

  for (let index = talk.lines.length - 1; index >= 0; index -= 1) {
    const line = talk.lines[index];

    if (line?.fromCompanion && line.text.trim() === talk.unfinished.trim()) {
      return line.id;
    }
  }

  return null;
}
