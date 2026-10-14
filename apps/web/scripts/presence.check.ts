import assert from "node:assert/strict";
import { decidePresence, type Floor } from "../src/realtime/presence.ts";

const names = ["阿七"];

function hear(
  floor: Floor,
  text: string,
  speaker: "user" | "other" | "unknown" = "user",
  otherVoicesRecent = false,
  sidePause = false,
) {
  return decidePresence({
    floor,
    text,
    speaker,
    names,
    otherVoicesRecent,
    sidePause,
  });
}

const alone = hear("together", "今天好累，想跟你说说");
assert.equal(alone.floor, "together");
assert.equal(alone.speak, true);
assert.equal(alone.lineRole, "user");
assert.equal(alone.appraise, true);

const opinion = hear("together", "你觉得呢");
assert.equal(opinion.floor, "together");
assert.equal(opinion.move, "stay");

const story = hear("together", "我妈今天过生日，我想给她挑个礼物");
assert.equal(story.floor, "together");
assert.equal(story.speak, true);

const aboutToday = hear("together", "今天你看起来有点累");
assert.equal(aboutToday.floor, "together");
assert.equal(aboutToday.speak, true);

const toMom = hear("together", "妈你吃了吗");
assert.equal(toMom.floor, "aside");
assert.equal(toMom.speak, false);
assert.equal(toMom.lineRole, "overheard");

const stepAway = hear("together", "等一下，有人找我");
assert.equal(stepAway.floor, "aside");
assert.equal(stepAway.speak, false);

const askFriend = hear("together", "小李你看这个对不对");
assert.equal(askFriend.floor, "aside");
assert.equal(askFriend.speak, false);

const hold = hear("together", "你先别说话");
assert.equal(hold.floor, "holding");
assert.equal(hold.speak, true);
assert.equal(hold.lineRole, "user");

const held = hear("holding", "这个方案我觉得可以");
assert.equal(held.floor, "holding");
assert.equal(held.speak, false);
assert.equal(held.lineRole, "overheard");

const called = hear("holding", "阿七");
assert.equal(called.floor, "together");
assert.equal(called.speak, true);

const release = hear("holding", "你可以说话了");
assert.equal(release.floor, "together");

const privateAgain = hear("holding", "我今天真的好累，你听我说");
assert.equal(privateAgain.floor, "together");
assert.equal(privateAgain.speak, true);

const stillHeld = hear("holding", "妈你觉得这个怎么样", "user", true);
assert.equal(stillHeld.floor, "aside");

const invite = hear("aside", "阿七你觉得他这样对吗");
assert.equal(invite.floor, "joined");
assert.equal(invite.speak, true);
assert.equal(invite.lineRole, "user");

const pullIn = hear("aside", "你也来说说");
assert.equal(pullIn.floor, "joined");

const backchannel = hear("aside", "嗯", "user", true);
assert.equal(backchannel.floor, "aside");
assert.equal(backchannel.speak, false);

const resume = hear("aside", "所以我刚才想说的是考试");
assert.equal(resume.floor, "together");
assert.equal(resume.speak, true);

const quietRoom = hear("aside", "那件事我想再想想");
assert.equal(quietRoom.floor, "aside");
assert.equal(quietRoom.speak, false);

const afterPause = hear("aside", "那件事我想再想想", "user", false, true);
assert.equal(afterPause.floor, "together");
assert.equal(afterPause.speak, true);

const otherVoice = hear("together", "你吃了吗", "other");
assert.equal(otherVoice.floor, "aside");
assert.equal(otherVoice.speak, false);
assert.equal(otherVoice.lineRole, "overheard");

const friendAsks = hear("aside", "阿七你觉得呢？", "other");
assert.equal(friendAsks.floor, "joined");
assert.equal(friendAsks.speak, true);
assert.equal(friendAsks.lineRole, "overheard");

const inGroup = hear("joined", "我觉得可以再改一版", "other");
assert.equal(inGroup.floor, "joined");
assert.equal(inGroup.speak, true);
assert.equal(inGroup.lineRole, "overheard");

const leaveGroup = hear("joined", "阿七我跟你说，我有点累");
assert.equal(leaveGroup.floor, "together");

const stayGroup = hear("joined", "阿七你觉得他这样行不行");
assert.equal(stayGroup.floor, "joined");

const explicitReturn = hear("joined", "他们走了，我们继续");
assert.equal(explicitReturn.floor, "together");
assert.equal(explicitReturn.speak, true);

const otherThing = hear("joined", "阿七还有其他事想跟你说");
assert.equal(otherThing.floor, "together");

const shortReply = hear("together", "好", "user", true);
assert.equal(shortReply.floor, "aside");
assert.equal(shortReply.speak, false);

console.log("presence checks passed");
