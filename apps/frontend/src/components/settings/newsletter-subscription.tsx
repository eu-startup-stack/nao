import { useState } from 'react';
import { Loader2, Mail, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLocalStorage } from '@/hooks/use-local-storage';
import { createLocalStorage } from '@/lib/local-storage';

const WAITLIST_API_URL = 'https://sunshine.getnao.io/api/waitlist/';

const newsletterSubscribedStorage = createLocalStorage<boolean>('newsletter-subscribed', false);

export function NewsletterSubscription({ email }: { email?: string }) {
	const [subscribed, setSubscribed] = useLocalStorage(newsletterSubscribedStorage);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [message, setMessage] = useState('');

	const handleSubscribe = async () => {
		if (!email || isSubmitting) {
			return;
		}

		setIsSubmitting(true);
		setMessage('');

		try {
			const response = await fetch(WAITLIST_API_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email }),
			});

			let data = null;
			try {
				data = await response.json();
			} catch {
				// ignore parse errors
			}

			const serverMsg = String(data?.message || data?.error || data?.detail || '');
			const isAlready =
				response.status === 409 ||
				response.status === 400 ||
				/already/i.test(serverMsg) ||
				/duplicate/i.test(serverMsg) ||
				/exists/i.test(serverMsg);

			if (response.ok || data?.success === true) {
				setSubscribed(true);
				setMessage("You're subscribed!");
			} else if (isAlready) {
				setSubscribed(true);
				setMessage("You're already subscribed!");
			} else {
				setMessage('Something went wrong. Please try again.');
			}
		} catch {
			setMessage('Could not reach the server. Please try again later.');
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<div className='flex items-center justify-between'>
			<div className='flex flex-col gap-0.5'>
				<p className='text-sm font-medium text-foreground h-5'>nao Newsletter</p>
				<p className='text-xs text-muted-foreground'>
					{message || 'Get product updates and news from nao. No spam.'}
				</p>
			</div>
			{subscribed ? (
				<div className='flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400'>
					<CheckCircle2 className='size-4' />
					Subscribed
				</div>
			) : (
				<Button variant='outline' size='sm' disabled={isSubmitting || !email} onClick={handleSubscribe}>
					{isSubmitting ? <Loader2 className='animate-spin' /> : <Mail />}
					{isSubmitting ? 'Subscribing...' : 'Subscribe'}
				</Button>
			)}
		</div>
	);
}
