import { Flexbox, Text } from '@lobehub/ui';
import { theme } from 'antd';

/**
 * The empty transcript's welcome, matching dsh's: a centered wordmark and one
 * line of tagline, nothing else. dsh's counterpart is its mark, the phrase
 * 「探索未至之境」, and a release badge — there is no list of suggested prompts,
 * because the composer below is already the invitation.
 *
 * The block carries no flex of its own: the shell places it at the bottom of the
 * space above the composer, with an equal spacer below, so a blank session reads
 * as one centered surface instead of a footer.
 */
export function EmptyState() {
  const { token } = theme.useToken();

  return (
    <Flexbox align="center" justify="center" gap={12} style={{ padding: '0 24px 28px' }}>
      <Text fontSize={26} weight={600} style={{ color: token.colorText }}>
        pi webx
      </Text>
      <Text fontSize={13} type="secondary">
        pi 会直接在当前工作区里读写文件、执行命令
      </Text>
    </Flexbox>
  );
}
