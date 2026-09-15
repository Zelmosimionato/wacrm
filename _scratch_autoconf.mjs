import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(
  readFileSync('/root/wacrm/.env.local', 'utf8')
    .split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0,i), l.slice(i+1)]; })
);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY);

const { data, error } = await supabase.from('automations').select('*').eq('id', '0b8e5576-efd4-4db6-b5cb-21d485a203dd').single();
console.log(JSON.stringify(data, null, 2), error);

const { data: steps, error: e2 } = await supabase.from('automation_steps').select('*').eq('automation_id', '0b8e5576-efd4-4db6-b5cb-21d485a203dd');
console.log('STEPS:', JSON.stringify(steps, null, 2), e2);
