export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      api_keys: {
        Row: {
          created_at: string
          encrypted_key: string
          id: string
          last4: string | null
          provider: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          encrypted_key: string
          id?: string
          last4?: string | null
          provider: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          encrypted_key?: string
          id?: string
          last4?: string | null
          provider?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
          version: number
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
          version?: number
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
          version?: number
        }
        Relationships: []
      }
      boardroom_runs: {
        Row: {
          budget_usd: number
          budget_warning: boolean
          consensus: Json | null
          constitution_version: number | null
          created_at: string
          dissent_ledger: Json | null
          error: string | null
          id: string
          kind: string
          loop_no: number
          project_id: string
          round_no: number
          spent_usd: number
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          budget_usd?: number
          budget_warning?: boolean
          consensus?: Json | null
          constitution_version?: number | null
          created_at?: string
          dissent_ledger?: Json | null
          error?: string | null
          id?: string
          kind: string
          loop_no?: number
          project_id: string
          round_no?: number
          spent_usd?: number
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          budget_usd?: number
          budget_warning?: boolean
          consensus?: Json | null
          constitution_version?: number | null
          created_at?: string
          dissent_ledger?: Json | null
          error?: string | null
          id?: string
          kind?: string
          loop_no?: number
          project_id?: string
          round_no?: number
          spent_usd?: number
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "boardroom_runs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      change_requests: {
        Row: {
          board_verdict: Json | null
          created_at: string
          description: string
          id: string
          plan_version_id: string | null
          project_id: string
          run_id: string | null
          status: string
          user_id: string
        }
        Insert: {
          board_verdict?: Json | null
          created_at?: string
          description: string
          id?: string
          plan_version_id?: string | null
          project_id: string
          run_id?: string | null
          status?: string
          user_id: string
        }
        Update: {
          board_verdict?: Json | null
          created_at?: string
          description?: string
          id?: string
          plan_version_id?: string | null
          project_id?: string
          run_id?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "change_requests_plan_version_id_fkey"
            columns: ["plan_version_id"]
            isOneToOne: false
            referencedRelation: "plan_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_requests_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_requests_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "boardroom_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      cohorts: {
        Row: {
          id: string
          instructor_id: string | null
          join_code: string
          name: string
          starts_at: string | null
        }
        Insert: {
          id?: string
          instructor_id?: string | null
          join_code: string
          name: string
          starts_at?: string | null
        }
        Update: {
          id?: string
          instructor_id?: string | null
          join_code?: string
          name?: string
          starts_at?: string | null
        }
        Relationships: []
      }
      cost_ledger: {
        Row: {
          cost_usd: number
          created_at: string
          id: string
          model_id: string | null
          project_id: string | null
          run_id: string | null
          seat: string | null
          tokens_in: number
          tokens_out: number
          user_id: string
        }
        Insert: {
          cost_usd?: number
          created_at?: string
          id?: string
          model_id?: string | null
          project_id?: string | null
          run_id?: string | null
          seat?: string | null
          tokens_in?: number
          tokens_out?: number
          user_id: string
        }
        Update: {
          cost_usd?: number
          created_at?: string
          id?: string
          model_id?: string | null
          project_id?: string | null
          run_id?: string | null
          seat?: string | null
          tokens_in?: number
          tokens_out?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_ledger_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "boardroom_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      intakes: {
        Row: {
          answers: Json
          created_at: string
          id: string
          project_id: string
          user_id: string
          validation_scores: Json | null
          verdict: string | null
        }
        Insert: {
          answers?: Json
          created_at?: string
          id?: string
          project_id: string
          user_id: string
          validation_scores?: Json | null
          verdict?: string | null
        }
        Update: {
          answers?: Json
          created_at?: string
          id?: string
          project_id?: string
          user_id?: string
          validation_scores?: Json | null
          verdict?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "intakes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      model_registry: {
        Row: {
          display_name: string | null
          enabled: boolean
          max_cost_per_run: number
          model_id: string
          role_prompt: string | null
          seat: string
          updated_at: string
          use_latest_alias: boolean
        }
        Insert: {
          display_name?: string | null
          enabled?: boolean
          max_cost_per_run?: number
          model_id: string
          role_prompt?: string | null
          seat: string
          updated_at?: string
          use_latest_alias?: boolean
        }
        Update: {
          display_name?: string | null
          enabled?: boolean
          max_cost_per_run?: number
          model_id?: string
          role_prompt?: string | null
          seat?: string
          updated_at?: string
          use_latest_alias?: boolean
        }
        Relationships: []
      }
      plan_versions: {
        Row: {
          content_md: string
          decision_log: Json | null
          dissent_ledger: Json | null
          features: Json | null
          id: string
          is_chair_ruled: boolean
          kind: string
          locked_at: string
          project_id: string
          source_run_id: string | null
          user_id: string
          version: number
        }
        Insert: {
          content_md: string
          decision_log?: Json | null
          dissent_ledger?: Json | null
          features?: Json | null
          id?: string
          is_chair_ruled?: boolean
          kind?: string
          locked_at?: string
          project_id: string
          source_run_id?: string | null
          user_id: string
          version: number
        }
        Update: {
          content_md?: string
          decision_log?: Json | null
          dissent_ledger?: Json | null
          features?: Json | null
          id?: string
          is_chair_ruled?: boolean
          kind?: string
          locked_at?: string
          project_id?: string
          source_run_id?: string | null
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "plan_versions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_versions_source_run_id_fkey"
            columns: ["source_run_id"]
            isOneToOne: false
            referencedRelation: "boardroom_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          cohort_id: string | null
          display_name: string | null
          id: string
          onboarded_at: string
          role: string
        }
        Insert: {
          cohort_id?: string | null
          display_name?: string | null
          id: string
          onboarded_at?: string
          role?: string
        }
        Update: {
          cohort_id?: string | null
          display_name?: string | null
          id?: string
          onboarded_at?: string
          role?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          created_at: string
          current_batch_no: number
          github_repo: string | null
          id: string
          lovable_project_url: string | null
          name: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_batch_no?: number
          github_repo?: string | null
          id?: string
          lovable_project_url?: string | null
          name: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_batch_no?: number
          github_repo?: string | null
          id?: string
          lovable_project_url?: string | null
          name?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      run_steps: {
        Row: {
          completed_at: string | null
          cost_usd: number
          created_at: string
          error: string | null
          id: string
          request: Json | null
          response_json: Json | null
          response_text: string | null
          round: number
          run_id: string
          seat: string
          status: string
          step_key: string
          tokens_in: number
          tokens_out: number
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          cost_usd?: number
          created_at?: string
          error?: string | null
          id?: string
          request?: Json | null
          response_json?: Json | null
          response_text?: string | null
          round: number
          run_id: string
          seat: string
          status?: string
          step_key: string
          tokens_in?: number
          tokens_out?: number
          user_id: string
        }
        Update: {
          completed_at?: string | null
          cost_usd?: number
          created_at?: string
          error?: string | null
          id?: string
          request?: Json | null
          response_json?: Json | null
          response_text?: string | null
          round?: number
          run_id?: string
          seat?: string
          status?: string
          step_key?: string
          tokens_in?: number
          tokens_out?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_steps_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "boardroom_runs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      instructs_cohort: {
        Args: { _cohort: string; _uid: string }
        Returns: boolean
      }
      is_admin: { Args: { _uid: string }; Returns: boolean }
      join_cohort: { Args: { code: string }; Returns: string }
      user_cohort: { Args: { _uid: string }; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
