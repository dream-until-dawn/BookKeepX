/**
 * 通用界面小组件：按钮、提示条、页面标题
 * 样式集中在这里，各页面保持一致；以后引入组件库时只需替换这里。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700',
  secondary: 'bg-white text-gray-700 ring-1 ring-gray-300 hover:bg-gray-50',
  danger: 'bg-white text-red-600 ring-1 ring-red-200 hover:bg-red-50',
  ghost: 'text-gray-600 hover:bg-gray-100',
};

export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`rounded-md px-2.5 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${VARIANT_CLASS[variant]} ${className}`}
      {...rest}
    />
  );
}

/** 错误提示条；message 为空时不渲染 */
export function ErrorBanner({ message, onClose }: { message: string | null; onClose?: () => void }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex items-start justify-between rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      <span>{message}</span>
      {onClose && (
        <button type="button" aria-label="关闭提示" onClick={onClose} className="ml-3 text-red-500">
          ×
        </button>
      )}
    </div>
  );
}

export function PageTitle({ children, description }: { children: ReactNode; description?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold">{children}</h1>
      {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
    </div>
  );
}

/** 小标签（如"预置""已隐藏"） */
export function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: 'gray' | 'amber' | 'blue' }) {
  const cls = {
    gray: 'bg-gray-100 text-gray-600',
    amber: 'bg-amber-100 text-amber-800',
    blue: 'bg-blue-50 text-blue-700',
  }[tone];
  return <span className={`rounded px-1.5 py-0.5 text-xs ${cls}`}>{children}</span>;
}

export const inputClass =
  'rounded-md border border-gray-300 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-500';
