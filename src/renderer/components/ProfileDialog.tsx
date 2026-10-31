import { useState } from 'react';
import { profileFieldErrors, type Profile } from '../../shared/profiles';
import { api } from '../api';
import { Dialog } from './Dialog';

interface Props {
  profile: Profile | null; // null = new
  onClose: () => void;
  onSaved: (p: Profile) => void;
}

interface FormState {
  name: string;
  host: string;
  port: string;
  username: string;
  authMode: 'privateKey' | 'privateKeyAndCertificate';
  privateKeyPath: string;
  certificatePath: string;
  initialRemoteDirectory: string;
  downloadDirectory: string;
}

function toForm(p: Profile | null): FormState {
  return {
    name: p?.name ?? '',
    host: p?.host ?? '',
    port: String(p?.port ?? 22),
    username: p?.username ?? '',
    authMode: p?.authMode ?? 'privateKey',
    privateKeyPath: p?.privateKeyPath ?? '',
    certificatePath: p?.certificatePath ?? '',
    initialRemoteDirectory: p?.initialRemoteDirectory ?? '',
    downloadDirectory: p?.downloadDirectory ?? '',
  };
}

function toInput(f: FormState): unknown {
  const opt = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  return {
    name: f.name,
    host: f.host,
    port: /^\d+$/.test(f.port.trim()) ? Number(f.port.trim()) : Number.NaN,
    username: f.username,
    authMode: f.authMode,
    privateKeyPath: f.privateKeyPath.trim(),
    certificatePath: f.authMode === 'privateKeyAndCertificate' ? opt(f.certificatePath) : null,
    initialRemoteDirectory: opt(f.initialRemoteDirectory),
    downloadDirectory: opt(f.downloadDirectory),
  };
}

export function ProfileDialog({ profile, onClose, onSaved }: Props): React.JSX.Element {
  const [form, setForm] = useState<FormState>(() => toForm(profile));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]): void =>
    setForm((f) => ({ ...f, [k]: v }));

  const browse = async (
    kind: 'privateKey' | 'certificate' | 'downloadDirectory',
  ): Promise<void> => {
    const r = await api().credentials.chooseFile(kind);
    if (r.ok && !r.value.canceled) {
      const field =
        kind === 'privateKey'
          ? 'privateKeyPath'
          : kind === 'certificate'
            ? 'certificatePath'
            : 'downloadDirectory';
      set(field, r.value.path);
    }
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const input = toInput(form);
    const local = profileFieldErrors(input);
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) return;
    setSaving(true);
    const r = await api().profiles.save(profile?.id, input);
    setSaving(false);
    if (r.ok) onSaved(r.value);
    else {
      setErrors(r.error.fields ?? {});
      setFormError(r.error.message);
    }
  };

  const field = (
    key: keyof FormState,
    label: string,
    opts: {
      placeholder?: string;
      type?: string;
      hint?: string;
      browse?: 'privateKey' | 'certificate' | 'downloadDirectory';
    } = {},
  ): React.JSX.Element => {
    const id = `pf-${key}`;
    const err = errors[key];
    const describedBy = [opts.hint ? `${id}-hint` : '', err ? `${id}-err` : '']
      .filter(Boolean)
      .join(' ');
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <div className="field-row">
          <input
            id={id}
            name={key}
            type={opts.type ?? 'text'}
            value={form[key]}
            placeholder={opts.placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={err ? true : undefined}
            aria-describedby={describedBy || undefined}
            onChange={(e) => set(key, e.target.value as never)}
          />
          {opts.browse && (
            <button
              type="button"
              onClick={() => void browse(opts.browse!)}
              aria-label={`Browse for ${label.toLowerCase()}`}
            >
              Browse…
            </button>
          )}
        </div>
        {opts.hint && (
          <p id={`${id}-hint`} className="hint">
            {opts.hint}
          </p>
        )}
        {err && (
          <p id={`${id}-err`} className="field-error" role="alert">
            {err}
          </p>
        )}
      </div>
    );
  };

  return (
    <Dialog
      title={profile ? 'Edit server' : 'Add server'}
      onClose={onClose}
      initialFocusId="pf-name"
      testId="profile-dialog"
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="profile-form">
        {field('name', 'Name', { placeholder: 'Production files' })}
        <div className="field-pair">
          {field('host', 'Host', { placeholder: 'sftp.example.com' })}
          {field('port', 'Port', { type: 'text' })}
        </div>
        {field('username', 'Username')}
        <fieldset className="field">
          <legend>Authentication</legend>
          <label className="radio">
            <input
              type="radio"
              name="authMode"
              value="privateKey"
              checked={form.authMode === 'privateKey'}
              onChange={() => set('authMode', 'privateKey')}
            />
            Private key
          </label>
          <label className="radio">
            <input
              type="radio"
              name="authMode"
              value="privateKeyAndCertificate"
              checked={form.authMode === 'privateKeyAndCertificate'}
              onChange={() => set('authMode', 'privateKeyAndCertificate')}
            />
            Private key + certificate
          </label>
        </fieldset>
        {field('privateKeyPath', 'Private key file', {
          browse: 'privateKey',
          hint: 'For example ~/.ssh/id_ed25519. Only the path is saved.',
        })}
        {form.authMode === 'privateKeyAndCertificate' &&
          field('certificatePath', 'Certificate file', {
            browse: 'certificate',
            hint: 'The CA-signed OpenSSH user certificate, usually id_ed25519-cert.pub.',
          })}
        {field('initialRemoteDirectory', 'Initial remote folder (optional)', {
          placeholder: '/srv/files',
        })}
        {field('downloadDirectory', 'Download folder (optional)', {
          browse: 'downloadDirectory',
          hint: 'Defaults to your Downloads folder.',
        })}
        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {profile ? 'Save' : 'Add server'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
