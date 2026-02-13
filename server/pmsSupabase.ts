import { Pool, QueryResult } from "pg";

// Initialize Neon PostgreSQL connection pool for PMS database
const pmsDatabaseUrl = process.env.PMS_DATABASE_URL || process.env.DATABASE_URL!;

export const pmsPool = new Pool({
  connectionString: pmsDatabaseUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

// PMS Project interface matching Supabase schema
export interface PMSProject {
  project_code: string;
  project_name: string;
  description?: string;
  status?: string;
  start_date?: string;
  end_date?: string;
  created_by_emp_code?: string;
  progress_percentage?: number;
  client_name?: string;
  department?: string; // Legacy single department field
  departments?: string[] | string; // New multiple departments field (array or comma-separated string)
  dept?: string; // Alternative department field name
  department_name?: string; // Alternative department field name
}

// PMS Task interface matching Supabase schema
export interface PMSTask {
  id: string;
  project_id: string;
  key_step_id?: string;
  task_name: string;
  description?: string;
  priority?: string;
  status?: string;
  start_date?: string;
  end_date?: string;
  assignee?: string;
  task_members?: string[];
  created_at?: string;
  assigner_id?: string;
  updated_at?: string;
}

// PMS Subtask interface matching Supabase schema
export interface PMSSubtask {
  id: string;
  task_id: string;
  title: string;
  assigned_to?: string;
  is_completed?: boolean;
  created_at?: string;
}

// Department name normalization mapping
const normalizeDepartment = (dept: string): string => {
  const normalized = dept.toLowerCase().trim();
  // Map variations to standard department names
  const departmentMappings: Record<string, string> = {
    'software': 'software',
    'software developers': 'software',
    'software developer': 'software',
    'finance': 'finance',
    'purchase': 'purchase',
    'purchases': 'purchase',
    'hr': 'hr',
    'hr & admin': 'hr',
    'hr and admin': 'hr',
    'human resources': 'hr',
    'human resources & admin': 'hr',
    'operations': 'operations',
    'operation': 'operations',
    'marketing': 'marketing',
    'sales': 'sales',
    'admin': 'admin',
    'administration': 'admin',
    'it': 'it',
    'information technology': 'it',
    'qa': 'qa',
    'quality assurance': 'qa',
    'testing': 'qa',
    // presales variants
    'presale': 'presales',
    'presales': 'presales',
    'pre-sales': 'presales',
    'pre sales': 'presales',
  };

  return departmentMappings[normalized] || normalized;
};

// Check if two departments are equivalent
const isDepartmentMatch = (userDept: string, projectDept: string): boolean => {
  return normalizeDepartment(userDept) === normalizeDepartment(projectDept);
};

export const getProjects = async (userRole?: string, userEmpCode?: string, userDepartment?: string): Promise<PMSProject[]> => {
  try {
    console.log("🔍 PMS getProjects called with:", { userRole, userEmpCode, userDepartment });

    console.log("📡 Executing PMS query to fetch Projects with departments...");

    // Query Neon PostgreSQL directly - get all projects
    const projectsResult: QueryResult = await pmsPool.query(`
      SELECT 
        p.id,
        p.title as project_name,
        p.project_code,
        p.client_name,
        p.description,
        p.status,
        p.start_date,
        p.end_date,
        p.progress as progress_percentage,
        p.created_at,
        p.updated_at
      FROM projects p
      ORDER BY p.title
    `);

    const projects = projectsResult.rows as PMSProject[] || [];

    // Get all department assignments
    const deptResult: QueryResult = await pmsPool.query(`
      SELECT project_id, department FROM project_departments
    `);

    // Map departments to projects
    const projectDepts: Record<string, string[]> = {};
    deptResult.rows.forEach((row: any) => {
      const projId = row.project_id;
      if (!projectDepts[projId]) {
        projectDepts[projId] = [];
      }
      projectDepts[projId].push(row.department);
    });

    // Enrich projects with their departments
    const enrichedProjects = projects.map(p => ({
      ...p,
      department: projectDepts[p.id as any] || []
    }));

    console.log(`📊 PMS projects returned: ${enrichedProjects.length} projects`);
    if (enrichedProjects.length > 0) {
      console.log("📋 First project sample:", JSON.stringify(enrichedProjects[0], null, 2));
    } else {
      console.log("⚠️ No projects found in PMS database");
    }

    // Apply client-side department filtering if user has department (including admins)
    if (userDepartment) {
      console.log("🔄 Applying client-side department filtering for:", userDepartment);
      const filteredProjects = enrichedProjects.filter(project => {
        // Handle multiple possible department field names and formats
        let projectDepts: string[] = [];

        // Check for department array field (new multiple departments format)
        if (project.department && Array.isArray(project.department)) {
          projectDepts = project.department;
        }
        // Check for departments array field (alternative naming)
        else if (project.departments && Array.isArray(project.departments)) {
          projectDepts = project.departments;
        }
        // Check for single department field (legacy format)
        else if (typeof project.department === 'string') {
          projectDepts = [project.department];
        }
        else if (project.dept) {
          projectDepts = [project.dept];
        }
        else if (project.department_name) {
          projectDepts = [project.department_name];
        }
        // Check for comma-separated string in departments field
        else if (typeof project.departments === 'string') {
          projectDepts = project.departments.split(',').map((d: string) => d.trim());
        }

        if (projectDepts.length === 0) {
          console.log(`⚠️ Project ${project.project_name} has no department assigned`);
          return false; // Exclude projects without department
        }

        // Check if user's department matches any of the project's departments
        const isMatch = projectDepts.some(dept => isDepartmentMatch(userDepartment, dept));
        if (isMatch) {
          console.log(`✅ Project "${project.project_name}" depts [${projectDepts.join(', ')}] matches "${userDepartment}"`);
        }
        return isMatch;
      });

      console.log(`📊 After department filtering: ${filteredProjects.length} projects (from ${enrichedProjects.length})`);
      return filteredProjects;
    }

    return enrichedProjects;
  } catch (error) {
    console.error("💥 Error connecting to PMS:", error);
    return []; // Return empty array on connection issues
  }
};

export const getTasks = async (projectId?: string, userDepartment?: string): Promise<PMSTask[]> => {
  try {
    console.log("📡 Executing PMS getTasks query for project:", projectId);

    let query = 'SELECT * FROM project_tasks ORDER BY task_name';
    const params: any[] = [];

    if (projectId) {
      // projectId is actually the project_code, need to join with projects table
      query = `
        SELECT pt.* FROM project_tasks pt
        INNER JOIN projects p ON pt.project_id = p.id
        WHERE p.project_code = $1
        ORDER BY pt.task_name
      `;
      params.push(projectId);
    }

    const result: QueryResult = await pmsPool.query(query, params);
    let tasks = result.rows as PMSTask[] || [];
    
    console.log(`📊 PMS tasks returned: ${tasks.length} tasks`);
    if (tasks.length > 0) {
      console.log("📋 First task sample:", JSON.stringify(tasks[0], null, 2));
    } else {
      console.log("⚠️ No tasks found in PMS database");
    }

    return tasks;
  } catch (error) {
    console.error("💥 Error connecting to PMS:", error);
    return []; // Return empty array on connection issues
  }
};

export const getTasksByProject = async (projectId: string, userDepartment?: string): Promise<PMSTask[]> => {
  try {
    console.log("🔍 PMS getTasksByProject called with projectId:", projectId);

    console.log("📡 Executing PMS getTasksByProject query...");

    // projectId is the project_code, need to join with projects table
    const result: QueryResult = await pmsPool.query(
      `SELECT pt.* FROM project_tasks pt
       INNER JOIN projects p ON pt.project_id = p.id
       WHERE p.project_code = $1
       ORDER BY pt.task_name`,
      [projectId]
    );

    let tasks = result.rows as PMSTask[] || [];
    console.log(`📊 PMS tasks returned for project ${projectId}: ${tasks.length} tasks`);
    if (tasks.length > 0) {
      console.log("📋 First task sample:", JSON.stringify(tasks[0], null, 2));
    } else {
      console.log(`⚠️ No tasks found in PMS database for project ${projectId}`);
    }

    return tasks;
  } catch (error) {
    console.error("💥 Error connecting to PMS:", error);
    return []; // Return empty array on connection issues
  }
};

export const getSubtasks = async (taskId?: string, userDepartment?: string): Promise<PMSSubtask[]> => {
  try {
    console.log("🔍 PMS getSubtasks called with taskId:", taskId, "userDepartment:", userDepartment);

    console.log("📡 Executing PMS getSubtasks query (fetching all subtasks)...");

    const result: QueryResult = await pmsPool.query(
      'SELECT * FROM subtasks ORDER BY created_at'
    );

    let subtasks = result.rows as PMSSubtask[] || [];
    console.log(`📊 PMS subtasks returned: ${subtasks.length} subtasks`);
    if (subtasks.length > 0) {
      console.log("📋 First subtask sample:", JSON.stringify(subtasks[0], null, 2));
      // Filter by taskId using various possible column names
      if (taskId) {
        console.log(`🔍 Filtering subtasks for taskId: ${taskId}`);
        subtasks = subtasks.filter(subtask => {
          const matches = subtask.task_id == taskId || (subtask as any).taskid == taskId || (subtask as any).task == taskId ||
                         (subtask as any).parent_task_id == taskId || (subtask as any).parent_task == taskId || (subtask as any).task_ref == taskId ||
                         (subtask as any).taskId == taskId;
          if (matches) {
            console.log(`✅ Found matching subtask:`, subtask);
          }
          return matches;
        });
        console.log(`📊 Filtered to ${subtasks.length} subtasks for task ${taskId}`);
      }
    } else {
      console.log("⚠️ No subtasks found in PMS database");
    }

    return subtasks;
  } catch (error) {
    console.error("💥 Error connecting to PMS:", error);
    return []; // Return empty array on connection issues
  }
};

// Update a PMS task (e.g., change end_date) and return updated row
export const updateTaskInPMS = async (taskId: string, updates: { end_date?: string, status?: string }): Promise<PMSTask | null> => {
  try {
    const setParts: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (updates.end_date !== undefined) {
      setParts.push(`end_date = $${idx++}`);
      params.push(updates.end_date);
    }
    if (updates.status !== undefined) {
      setParts.push(`status = $${idx++}`);
      params.push(updates.status);
    }

    if (setParts.length === 0) return null;

    params.push(taskId);
    const query = `UPDATE project_tasks SET ${setParts.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`;
    const result: QueryResult = await pmsPool.query(query, params);
    if (result.rows && result.rows.length > 0) {
      return result.rows[0] as PMSTask;
    }
    return null;
  } catch (error) {
    console.error('Error updating task in PMS:', error);
    return null;
  }
};
