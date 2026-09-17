import { Flexbox, Text } from '@lobehub/ui';
import { theme } from 'antd';
import { Bug, FileCode, FolderSearch, Sparkles } from 'lucide-react';

import type { ReactNode } from 'react';

const SUGGESTIONS: { icon: ReactNode; title: string; prompt: string }[] = [
  {
    icon: <FolderSearch size={16} />,
    title: '梳理这个仓库的结构',
    prompt: '浏览当前工作区，给我讲清楚目录结构和各模块的职责，最后画一棵目录树。',
  },
  {
    icon: <Bug size={16} />,
    title: '修一个 bug',
    prompt: '帮我找出当前项目里一个可疑的 bug，说明复现路径和根因，然后修复它。',
  },
  {
    icon: <FileCode size={16} />,
    title: '给关键模块补测试',
    prompt: '找出当前项目里最核心、但缺少测试覆盖的模块，为它补上有价值的测试。',
  },
  {
    icon: <Sparkles size={16} />,
    title: '解释一段代码',
    prompt: '挑一段当前项目里最难懂的代码，逐行解释它在做什么、为什么这么写。',
  },
];

/**
 * LobeChat-style greeting shown instead of an empty transcript.
 * Suggestions fill the composer rather than sending immediately, so the user
 * can edit before dispatching.
 */
export function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  const { token } = theme.useToken();

  return (
    <Flexbox
      align="center"
      justify="center"
      gap={24}
      style={{ flex: 1, minHeight: 0, padding: '32px 24px' }}
    >
      <Flexbox align="center" gap={10}>
        <Text fontSize={22} weight={600} style={{ color: token.colorText }}>
          今天想让 pi 做点什么？
        </Text>
        <Text fontSize={13} type="secondary">
          pi 会直接在当前工作区里读写文件、执行命令
        </Text>
      </Flexbox>

      <Flexbox
        gap={8}
        style={{ width: '100%', maxWidth: 620 }}
        direction="vertical"
      >
        {SUGGESTIONS.map((suggestion) => (
          <Flexbox
            key={suggestion.title}
            horizontal
            align="center"
            gap={12}
            onClick={() => onPick(suggestion.prompt)}
            style={{
              padding: '10px 14px',
              cursor: 'pointer',
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadiusLG,
              background: token.colorBgContainer,
            }}
          >
            <span style={{ color: token.colorPrimary, flexShrink: 0 }}>{suggestion.icon}</span>
            <Text fontSize={13}>{suggestion.title}</Text>
          </Flexbox>
        ))}
      </Flexbox>
    </Flexbox>
  );
}
