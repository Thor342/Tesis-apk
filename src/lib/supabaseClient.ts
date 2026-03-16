import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://puqufwhzbjpjsodsnddz.supabase.co'
const supabaseKey = 'sb_publishable_yaIzgYYU6Lv680qyubFDuw_6NmQvrcl'

export const supabase = createClient(supabaseUrl, supabaseKey)