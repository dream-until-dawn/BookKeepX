/** 登录页 */
import { loginRequestSchema } from '@bookkeepx/contracts';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AuthCard, Field, FormError, SubmitButton } from './AuthForm.tsx';
import { login } from './api.ts';
import { useAuthForm } from './useAuthForm.ts';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [params] = useSearchParams();
  const { onSubmit, fieldErrors, formError, pending } = useAuthForm(loginRequestSchema, login);

  return (
    <AuthCard title="登录">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ email, password });
        }}
      >
        <FormError message={formError} />
        <Field
          label="邮箱"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          error={fieldErrors.email}
        />
        <Field
          label="密码"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          error={fieldErrors.password}
        />
        <SubmitButton pending={pending}>登录</SubmitButton>
      </form>
      <p className="mt-4 text-center text-sm text-gray-600">
        还没有账号？
        <Link className="text-blue-600 hover:underline" to={`/register${params.size ? `?${params}` : ''}`}>
          注册
        </Link>
      </p>
    </AuthCard>
  );
}
