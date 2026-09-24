/** 注册页（注册成功即登录） */
import { registerRequestSchema } from '@bookkeepx/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { AuthCard, Field, FormError, SubmitButton } from './AuthForm.tsx';
import { register } from './api.ts';
import { useAuthForm } from './useAuthForm.ts';

export function RegisterPage() {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { onSubmit, fieldErrors, formError, pending } = useAuthForm(registerRequestSchema, register);

  return (
    <AuthCard title="注册新账号">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ email, password, displayName });
        }}
      >
        <FormError message={formError} />
        <Field
          label="昵称"
          name="displayName"
          autoComplete="nickname"
          value={displayName}
          onChange={setDisplayName}
          error={fieldErrors.displayName}
        />
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
          label="密码（至少 8 位）"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={fieldErrors.password}
        />
        <SubmitButton pending={pending}>注册</SubmitButton>
      </form>
      <p className="mt-4 text-center text-sm text-gray-600">
        已有账号？
        <Link className="text-blue-600 hover:underline" to="/login">
          登录
        </Link>
      </p>
    </AuthCard>
  );
}
