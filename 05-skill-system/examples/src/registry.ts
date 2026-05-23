/**
 * Skill Registry
 *
 * 负责 Skill 的注册、存储和检索。
 * 核心功能：
 * 1. 注册时自动计算 description 向量（embedding）
 * 2. 语义检索：向量召回 + LLM 精排两阶段
 *
 * 数据库依赖：PostgreSQL + pgvector 扩展
 * 本示例使用内存 Map 模拟数据库，生产中替换为 pg 客户端。
 */

import type {
  SkillRecord,
  CreateSkillInput,
  SkillType,
} from './types.js';

// ─── 向量化工具函数 ──────────────────────────────────────────────

/**
 * 计算文本的向量表示。
 *
 * 生产中调用 Voyage AI voyage-3 API（1024 维，全书默认）。
 * 必须和 skills 表 embedding 列使用相同的模型，否则向量空间不对齐。
 * 切换到 OpenAI text-embedding-3-small（1536 维）时需要同步修改 EMBEDDING_DIM。
 *
 * 本示例用随机向量代替，仅用于演示接口。
 */
const EMBEDDING_DIM = 1024;

async function embedText(text: string): Promise<number[]> {
  // 生产实现（取消注释后使用，需安装 voyageai 包）：
  // const VoyageAIClient = (await import('voyageai')).default;
  // const client = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY });
  // const response = await client.embed({ input: [text], model: 'voyage-3' });
  // return response.data[0].embedding;

  // Stub：用文本哈希生成伪随机向量，仅用于演示
  console.log(`[embed] 向量化文本（${text.length} 字符）...`);
  const seed = text.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  // 生成 1024 维向量并归一化（与 voyage-3 默认输出维度一致）
  const vec = Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(seed + i) * 0.5);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

/**
 * 计算两个向量的余弦相似度（0~1，越大越相似）。
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('向量维度不一致');
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Registry 实现 ───────────────────────────────────────────────

/**
 * Skill Registry。
 *
 * 生产实现：skills 存储在 PostgreSQL，向量检索用 pgvector。
 * 示例实现：内存 Map，向量计算用 JS。
 * 接口完全一致，替换存储层不需要修改调用代码。
 */
export class SkillRegistry {
  // 内存存储（生产中替换为 pg 连接）
  private skills: Map<string, SkillRecord> = new Map();

  /**
   * 注册新 Skill。
   *
   * 自动计算 description 的向量并存储，用于后续语义检索。
   * description 变更时需调用 updateSkill，重新计算向量。
   */
  async registerSkill(input: CreateSkillInput): Promise<SkillRecord> {
    const id = `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 计算 description 向量（生产中可异步执行，先插入再回填）
    const embedding = await embedText(input.description);

    const record: SkillRecord = {
      id,
      ...input,
      embedding,
      createdAt: new Date(),
    };

    this.skills.set(id, record);
    console.log(`[registry] 注册 Skill: ${input.name} (${id})`);

    return record;
  }

  /**
   * 更新 Skill。
   *
   * 如果 description 发生变化，自动重新计算向量。
   * 向量不及时更新会导致检索结果基于旧的语义，出现漏召回。
   */
  async updateSkill(
    id: string,
    updates: Partial<Omit<SkillRecord, 'id' | 'createdAt'>>
  ): Promise<SkillRecord> {
    const existing = this.skills.get(id);
    if (!existing) throw new Error(`Skill ${id} 不存在`);

    // description 变更时重新向量化
    let embedding = existing.embedding;
    if (updates.description && updates.description !== existing.description) {
      console.log(`[registry] description 变更，重新向量化 Skill ${id}`);
      embedding = await embedText(updates.description);
    }

    const updated: SkillRecord = { ...existing, ...updates, embedding };
    this.skills.set(id, updated);
    return updated;
  }

  /** 按 ID 获取 Skill */
  getSkill(id: string): SkillRecord | undefined {
    return this.skills.get(id);
  }

  /** 获取某租户可用的所有 Skill（内置 + 该租户自定义） */
  listSkillsForTenant(tenantId: string): SkillRecord[] {
    return Array.from(this.skills.values()).filter(
      (s) => s.isActive && (s.tenantId === null || s.tenantId === tenantId)
    );
  }

  /**
   * 语义检索：找到最相关的 Skill。
   *
   * 两阶段：
   * 1. 向量召回：用 pgvector 找余弦相似度最高的 topK*2 个候选
   * 2. LLM 精排：用小模型从候选中选出最终 topK 个
   *
   * 为什么不直接用 LLM 选？
   * 上千个 Skill 的 description 全部放入 context 会超出 token 限制，
   * 而且大量不相关信息会稀释 LLM 的注意力，降低选择准确率。
   * 向量召回先缩小范围，LLM 精排再做语义理解，两者各做自己擅长的事。
   */
  async findRelevantSkills(
    userMessage: string,
    tenantId: string,
    topK: number = 5
  ): Promise<SkillRecord[]> {
    // 第一步：向量化用户消息
    const queryEmbedding = await embedText(userMessage);

    // 第二步：向量召回（余弦相似度排序）
    const candidates = this.listSkillsForTenant(tenantId)
      .filter((s) => s.embedding != null)
      .map((s) => ({
        skill: s,
        // 余弦相似度：1 表示完全相同，0 表示无关
        similarity: cosineSimilarity(queryEmbedding, s.embedding!),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK * 2); // 多取一倍，留给精排

    if (candidates.length === 0) return [];

    console.log(
      `[registry] 向量召回 ${candidates.length} 个候选 Skill：`,
      candidates.map((c) => `${c.skill.name}(${c.similarity.toFixed(3)})`).join(', ')
    );

    // 第三步：LLM 精排
    // 生产中调用小模型（claude-haiku 或 gpt-4o-mini），成本低延迟低
    const reranked = await this.rerankWithLLM(
      candidates.map((c) => c.skill),
      userMessage,
      topK
    );

    return reranked;
  }

  /**
   * LLM 精排。
   *
   * 本示例用相似度排序代替真实 LLM 调用。
   * 生产中替换为对小模型（claude-haiku）的调用。
   */
  private async rerankWithLLM(
    candidates: SkillRecord[],
    _userMessage: string,
    topK: number
  ): Promise<SkillRecord[]> {
    // 生产实现（示意）：
    // const candidateList = candidates
    //   .map((s, i) => `${i + 1}. [${s.id}] ${s.name}: ${s.description}`)
    //   .join('\n');
    //
    // const response = await llmClient.generate({
    //   model: 'claude-3-haiku-20240307',
    //   messages: [{
    //     role: 'user',
    //     content: `用户消息："${userMessage}"\n\n候选 Skill:\n${candidateList}\n\n选出最适合的 ${topK} 个，返回编号（逗号分隔）：`
    //   }]
    // });
    //
    // const indices = response.content.split(',').map(s => parseInt(s.trim()) - 1);
    // return indices.map(i => candidates[i]).filter(Boolean);

    // Stub：直接返回前 topK 个（已按向量相似度排序）
    return candidates.slice(0, topK);
  }

  /** 获取 Registry 中所有 Skill 数量（调试用） */
  get size(): number {
    return this.skills.size;
  }

  /** 将内置 Skill 批量注册到 Registry */
  async registerBuiltinSkills(
    builtinSkills: Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      timeout: number;
      isCacheable: boolean;
    }>
  ): Promise<void> {
    for (const skill of builtinSkills) {
      await this.registerSkill({
        tenantId: null,          // 内置 Skill 不属于任何租户
        name: skill.name,
        description: skill.description,
        type: 'builtin' as SkillType,
        config: {},
        inputSchema: {},
        outputSchema: {},
        isActive: true,
        timeoutMs: skill.timeout,
      });
    }
  }
}
