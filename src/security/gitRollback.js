import simpleGit from 'simple-git';
const git = simpleGit();
export async function createCheckpoint() {
    try {
        console.log("🔒 [Security] 强制保存真实 Git 快照...");
        await git.add('./*');
        await git.commit('chore: devagent auto checkpoint');
    } catch (e) { console.error("快照失败:", e.message); }
}
export async function rollback() {
    try {
        console.log("⏪ [Security] 物理回滚中...");
        await git.reset(['--hard']);
        await git.clean('f', ['-d']);
    } catch (e) { console.error("回滚失败:", e.message); }
}
