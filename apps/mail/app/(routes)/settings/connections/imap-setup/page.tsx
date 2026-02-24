import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { SettingsCard } from '@/components/settings/settings-card';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTRPC } from '@/providers/query-provider';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { m } from '@/paraglide/messages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { useState } from 'react';
import * as z from 'zod';

const IMAP_PRESETS: Record<
  string,
  { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }
> = {
  'gmail.com': {
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
  },
  'outlook.com': {
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
  },
  'yahoo.com': {
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 587,
  },
  'fastmail.com': {
    imapHost: 'imap.fastmail.com',
    imapPort: 993,
    smtpHost: 'smtp.fastmail.com',
    smtpPort: 587,
  },
  'protonmail.com': {
    imapHost: '127.0.0.1',
    imapPort: 1143,
    smtpHost: '127.0.0.1',
    smtpPort: 1025,
  },
  'icloud.com': {
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
  },
};

const formSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  imapHost: z.string().min(1),
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean(),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  username: z.string().min(1),
  password: z.string().min(1),
});

export default function ImapSetupPage() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { mutateAsync: testConnection, isPending: isTesting } = useMutation(
    trpc.connections.testImapConnection.mutationOptions()
  );
  const { mutateAsync: createConnection, isPending: isSaving } = useMutation(
    trpc.connections.createImapConnection.mutationOptions()
  );
  const [discoveredFolders, setDiscoveredFolders] = useState<any>(null);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: '',
      name: '',
      imapHost: '',
      imapPort: 993,
      imapSecure: true,
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      username: '',
      password: '',
    },
  });

  const handleEmailBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const email = e.target.value;
    if (email && email.includes('@')) {
      const domain = email.split('@')[1].toLowerCase();
      if (IMAP_PRESETS[domain]) {
        const preset = IMAP_PRESETS[domain];
        form.setValue('imapHost', preset.imapHost);
        form.setValue('imapPort', preset.imapPort);
        form.setValue('smtpHost', preset.smtpHost);
        form.setValue('smtpPort', preset.smtpPort);
      }
      if (!form.getValues('username')) {
        form.setValue('username', email);
      }
    }
  };

  const handleTest = async () => {
    const isValid = await form.trigger();
    if (!isValid) return;

    try {
      const values = form.getValues();
      const res = await testConnection(values);
      setDiscoveredFolders(res.folders);
      toast.success(m['pages.settings.connections.imap.status.success']());
    } catch (err: any) {
      toast.error(
        m['pages.settings.connections.imap.status.failed']({
          error: err.message || 'Unknown error',
        })
      );
    }
  };

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    if (!discoveredFolders) {
      toast.error('Please test the connection first');
      return;
    }
    
    try {
      await createConnection({
        ...values,
        sentFolder: discoveredFolders.sent,
        trashFolder: discoveredFolders.trash,
        draftsFolder: discoveredFolders.drafts,
        spamFolder: discoveredFolders.spam,
      });
      toast.success('IMAP connection created successfully!');
      navigate('/settings/connections');
    } catch (err: any) {
      toast.error(`Failed to create connection: ${err.message}`);
    }
  };

  return (
    <div className="grid gap-6">
      <SettingsCard
        title={m['pages.settings.connections.imap.title']()}
        description={m['pages.settings.connections.imap.subtitle']()}
        footer={
          <div className="flex gap-4">
            <Button
              type="button"
              variant="outline"
              onClick={handleTest}
              disabled={isTesting || isSaving}
            >
              {isTesting
                ? m['pages.settings.connections.imap.actions.testing']()
                : m['pages.settings.connections.imap.actions.test']()}
            </Button>
            <Button
              type="button"
              onClick={form.handleSubmit(onSubmit)}
              disabled={!discoveredFolders || isTesting || isSaving}
            >
              {isSaving
                ? m['pages.settings.connections.imap.actions.saving']()
                : m['pages.settings.connections.imap.actions.save']()}
            </Button>
          </div>
        }
      >
        <Form {...form}>
          <form className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{m['pages.settings.connections.imap.fields.email']()}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="you@example.com"
                        {...field}
                        onBlur={(e) => {
                          field.onBlur();
                          handleEmailBlur(e);
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{m['pages.settings.connections.imap.fields.name']()}</FormLabel>
                    <FormControl>
                      <Input placeholder="John Doe" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{m['pages.settings.connections.imap.fields.username']()}</FormLabel>
                    <FormControl>
                      <Input placeholder="you@example.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{m['pages.settings.connections.imap.fields.password']()}</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="********" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="rounded-lg border p-4">
              <h3 className="mb-4 text-sm font-medium">IMAP Settings</h3>
              <div className="grid gap-4 md:grid-cols-[1fr_100px_auto]">
                <FormField
                  control={form.control}
                  name="imapHost"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{m['pages.settings.connections.imap.fields.imapHost']()}</FormLabel>
                      <FormControl>
                        <Input placeholder="imap.example.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="imapPort"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{m['pages.settings.connections.imap.fields.imapPort']()}</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          onChange={(e) => field.onChange(parseInt(e.target.value))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="imapSecure"
                  render={({ field }) => (
                    <FormItem className="flex flex-col items-center justify-center pt-2">
                      <FormLabel className="mb-2">
                        {m['pages.settings.connections.imap.fields.imapSecure']()}
                      </FormLabel>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <h3 className="mb-4 text-sm font-medium">SMTP Settings</h3>
              <div className="grid gap-4 md:grid-cols-[1fr_100px_auto]">
                <FormField
                  control={form.control}
                  name="smtpHost"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{m['pages.settings.connections.imap.fields.smtpHost']()}</FormLabel>
                      <FormControl>
                        <Input placeholder="smtp.example.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="smtpPort"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{m['pages.settings.connections.imap.fields.smtpPort']()}</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          onChange={(e) => field.onChange(parseInt(e.target.value))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="smtpSecure"
                  render={({ field }) => (
                    <FormItem className="flex flex-col items-center justify-center pt-2">
                      <FormLabel className="mb-2">
                        {m['pages.settings.connections.imap.fields.smtpSecure']()}
                      </FormLabel>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {discoveredFolders && (
              <div className="rounded-lg border border-green-500/20 bg-green-500/10 p-4">
                <p className="text-sm font-medium text-green-600 dark:text-green-400">
                  {m['pages.settings.connections.imap.status.foldersFound']({ count: 4 })}
                </p>
                <ul className="mt-2 grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                  <li>Sent: {discoveredFolders.sent}</li>
                  <li>Trash: {discoveredFolders.trash}</li>
                  <li>Drafts: {discoveredFolders.drafts}</li>
                  <li>Spam: {discoveredFolders.spam}</li>
                </ul>
              </div>
            )}
          </form>
        </Form>
      </SettingsCard>
    </div>
  );
}
