import simpleGit from 'simple-git';
const git = simpleGit();
export async function createCheckpoint() {
    try {
        console.log("🔒 [Security] 强制保存真实 Git 快照...");
        await git.add('./*');
        await git.commit('chore: devagent auto checkpoint');
    } catch (e) { console.error("快照失败:", e.message); }
}
/**
 * 安全回滚：恢复快照，但绝对保护基础设施和 AI 记忆
 */
export async function rollback() {
    try {
        console.log("⏪ [Security] 触发物理回滚，正在恢复代码...");
        
        // 1. 恢复被修改的文件内容
        await git.reset(['--hard']);
        
        // 2. 清理多余文件（仅文件，不删除目录），并打上“免死金牌” (-e = exclude)
        // 绝对不能删除依赖、环境变量、AI 的黑名单记忆库，以及任何未追踪目录结构！
        await git.clean('f', [
            '-e', 'node_modules', 
            '-e', '.env', 
            '-e', '.devagent_state.json'
        ]);
        
        console.log("✅ [Security] 物理回滚执行完毕，基础设施与记忆已安全保留！");
    } catch (error) {
        console.error("❌ [Security] 回滚失败:", error.message);
    }
}
