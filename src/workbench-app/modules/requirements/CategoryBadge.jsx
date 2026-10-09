import { categoryOf } from './model.jsx'

/**
 * 需求分类的轻量徽标（新功能 / 需求变更 / 问题修复 / 体验优化）。
 * 复用共享 `.chip` 的令牌样式，模块前缀类名便于定位；文案本身说明分类，
 * 颜色只是辅助，未知取值原样显示。
 */
export default function CategoryBadge({ value, testid }) {
  const category = categoryOf(value)
  return <span className={`chip ${category.tone} req-category`} data-testid={testid}>{category.label}</span>
}
