/**
 * SideTeX 宿主半边。
 *
 * 方法：装配项目状态中心（编译/SyncTeX/变更审阅），注册 /dsh-latex 路由、两个模型工具
 *      与一段系统提示；所有注册都挂在 ctx 的 effect 上，卸载即清理。
 * 对象：一个 profile 里的 LaTeX 工作台插件。
 */
import { createProjectStore } from './project.js'
import { createRoute } from './route.js'
import { registerTools } from './tool.js'

/** 模型可见的简短工作流提示。 */
const SYSTEM_PROMPT = [
  '本工作区启用了 LaTeX 实时编译（右侧栏 LaTeX 标签页；保存 .tex 后自动重编译并刷新 PDF）。',
  '- 改完 .tex 后调用 latex_compile 获取错误、页数与耗时；不要手动运行 pdflatex/latexmk。',
  '- latex_review 查看相对“已接受基线”的改动；接受/放弃由用户决定，除用户明确要求外不要调用 accept/reject。',
].join('\n')

/**
 * 插件入口。
 * @param {object} ctx - cordis 上下文
 * @param {object} [config] - 插件配置（可含 texBin / systemPrompt）
 */
export function apply(ctx, config = {}) {
  const options = {
    texBin: typeof config.texBin === 'string' && config.texBin !== '' ? config.texBin : undefined,
  }
  const store = createProjectStore(options)
  ctx.effect(() => () => store.dispose(), 'dsh-side-tex: project store')

  if (config.systemPrompt !== false) {
    ctx.inject(['systemPrompt'], (injected) => {
      const systemPrompt = injected.get('systemPrompt')
      if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return undefined
      try {
        return systemPrompt.section({ name: 'side-tex', order: 55, text: SYSTEM_PROMPT })
      } catch {
        return undefined
      }
    })
  }

  ctx.inject(['webServer'], (injected) => {
    const webServer = injected.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return undefined
    const route = createRoute({ ctx, store })
    const registered = []
    try {
      registered.push(webServer.register({ kind: 'prefix', path: '/dsh-latex/api', handler: route.api }))
      registered.push(webServer.register({ kind: 'exact', path: '/dsh-latex/pdf', handler: route.pdf }))
      registered.push(webServer.register({ kind: 'prefix', path: '/dsh-latex/vendor', handler: route.vendor }))
    } catch (error) {
      for (const dispose of registered.reverse()) {
        try {
          dispose()
        } catch {
          // 忽略
        }
      }
      throw error
    }
    return () => {
      for (const dispose of registered.reverse()) {
        try {
          dispose()
        } catch {
          // 忽略
        }
      }
    }
  })

  ctx.inject(['tools'], (injected) => {
    const tools = injected.get('tools')
    if (tools === undefined || typeof tools.register !== 'function') return undefined
    let dispose = null
    let cancelled = false
    void registerTools({ ctx, store, tools, config })
      .then((fn) => {
        if (cancelled) {
          if (typeof fn === 'function') fn()
          return
        }
        dispose = fn
      })
      .catch(() => {
        // 工具注册失败不阻断其余功能
      })
    return () => {
      cancelled = true
      if (typeof dispose === 'function') {
        dispose()
        dispose = null
      }
    }
  })
}
