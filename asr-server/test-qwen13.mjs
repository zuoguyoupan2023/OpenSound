import { getLlama, LlamaChatSession, QwenChatWrapper } from 'node-llama-cpp';
const llama = await getLlama();
const model = await llama.loadModel({ modelPath: 'models/llm/Qwen3-8B-Q4_K_M.gguf', gpuLayers: 32 });
const ctx = await model.createContext({ contextSize: 1024 });
const session = new LlamaChatSession({ contextSequence: ctx.getSequence(), chatWrapper: new QwenChatWrapper({ variation: '3' }) });
const res = await session.prompt('用一句话介绍你自己', { maxTokens: 60, temperature: 0.7 });
console.log('RESULT:', JSON.stringify(res));
