/** Public diagnostics use known categories, never provider bodies, paths or credentials. */
export function agentFailureDetail(message: string): { category: string; summary: string } {
  if (/finish_reason|模型服务输出流未完整结束/i.test(message)) {
    return { category: 'provider_stream_incomplete', summary: '模型服务输出流未完整结束' };
  }
  if (/需求.*修订|需求.*版本|requirement.*version/i.test(message)) {
    return { category: 'requirement_version_conflict', summary: '需求已修订，原输入版本不能继续执行' };
  }
  if (/api key|登录.*模型|authentication|unauthorized/i.test(message)) {
    return { category: 'model_auth', summary: '模型认证不可用' };
  }
  if (/cancel|abort|取消|关闭/i.test(message)) return { category: 'cancelled', summary: '执行已取消或中断' };
  if (/超时|timed? out|timeout/i.test(message)) return { category: 'timeout', summary: 'Agent 回合或等待超时' };
  if (/工作区|工作目录|workspace/i.test(message)) return { category: 'workspace', summary: 'Agent 工作目录不可用' };
  return { category: 'execution_failed', summary: '执行未完成，请核对关联消息和工具记录' };
}
