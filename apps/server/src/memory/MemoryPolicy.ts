import type { MemoryCategory } from "./MemoryTypes";

export type MemoryCardinality =
  | "single-current"
  | "multi-value";

type MemoryPolicy = {
  cardinality: MemoryCardinality;
  category: MemoryCategory;
};

const policies: Record<string, MemoryPolicy> = {
  // 身份信息
  user_name: {
    cardinality: "single-current",
    category: "identity",
  },
  birthday: {
    cardinality: "single-current",
    category: "identity",
  },
  // 平时怎么称呼。不是姓名，改口就换掉当前这一条。
  preferred_address: {
    cardinality: "single-current",
    category: "identity",
  },

  // 当前事实
  city: {
    cardinality: "single-current",
    category: "fact",
  },
  occupation: {
    cardinality: "single-current",
    category: "fact",
  },
  education: {
    cardinality: "single-current",
    category: "fact",
  },

  // 多值偏好
  favorite_food: {
    cardinality: "multi-value",
    category: "preference",
  },
  favorite_drink: {
    cardinality: "multi-value",
    category: "preference",
  },
  hobby: {
    cardinality: "multi-value",
    category: "preference",
  },
  interest: {
    cardinality: "multi-value",
    category: "preference",
  },
  favorite_music: {
    cardinality: "multi-value",
    category: "preference",
  },
  favorite_movie: {
    cardinality: "multi-value",
    category: "preference",
  },

  // 关系信息
  pet: {
    cardinality: "multi-value",
    category: "relationship",
  },
  important_person: {
    cardinality: "multi-value",
    category: "relationship",
  },

  // 长期目标和习惯
  important_goal: {
    cardinality: "multi-value",
    category: "event",
  },
  habit: {
    cardinality: "multi-value",
    category: "fact",
  },
  // 大致作息。当前只有一份，更正时换掉旧的。
  daily_routine: {
    cardinality: "single-current",
    category: "fact",
  },

  // 难过时想被听，还是想要办法。当前只有一种。
  when_sad: {
    cardinality: "single-current",
    category: "preference",
  },
  // 不想被碰的话题。可以同时有好几条。
  avoid_topic: {
    cardinality: "multi-value",
    category: "preference",
  },

  // 正在做的事。可以同时有好几件。
  current_activity: {
    cardinality: "multi-value",
    category: "event",
  },
  // 生日以外在意的日子。可以有多个，内容里带可读日期。
  important_date: {
    cardinality: "multi-value",
    category: "event",
  },
};

export function listMemoryKeys(): Array<{
  key: string;
  category: MemoryCategory;
  cardinality: MemoryCardinality;
}> {
  return Object.entries(policies).map(([key, policy]) => ({
    key,
    category: policy.category,
    cardinality: policy.cardinality,
  }));
}

export function isValidMemoryKey(key: string): boolean {
  const normalizedKey = key.trim();

  return (
    normalizedKey.length > 0 &&
    Object.prototype.hasOwnProperty.call(
      policies,
      normalizedKey,
    )
  );
}

export function getMemoryPolicy(
  key: string,
): MemoryCardinality {
  const normalizedKey = key.trim();
  const policy = policies[normalizedKey];

  if (!policy) {
    throw new Error(
      `Unknown memory key: ${normalizedKey}`,
    );
  }

  return policy.cardinality;
}

export function getMemoryCategory(
  key: string,
): MemoryCategory {
  const normalizedKey = key.trim();
  const policy = policies[normalizedKey];

  if (!policy) {
    throw new Error(
      `Unknown memory key: ${normalizedKey}`,
    );
  }

  return policy.category;
}